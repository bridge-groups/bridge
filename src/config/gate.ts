import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkConfig, formatIssue } from './load.ts';
import { configChanges, describeChanges, type ConfigChange } from './changes.ts';
import type { BridgeConfig } from './schema.ts';
import type { Bridge } from '../core/bridge.ts';

export function configSha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * The text of the config file the bridge last applied, kept outside the file's folder so editing the folder
 * doesn't edit the record. Widening changes are measured against it, across restarts.
 */
export class AppliedConfig {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  static for(configPath: string, dir = join(homedir(), '.bridge', 'applied')): AppliedConfig {
    const id = createHash('sha256').update(realpathSync(configPath)).digest('hex').slice(0, 16);
    return new AppliedConfig(join(dir, `${id}.yaml`));
  }

  read(): string | undefined {
    try {
      return readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  write(text: string) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export const UNREADABLE_RECORD =
  'the record of the config applied last is not valid for this version of bridge, so changes against it ' +
  'cannot be reviewed — check the file, then confirm it with "bridge check --apply"';

/** A config file that widens access and waits for an owner. */
export interface PendingConfig {
  sha: string;
  changes: ConfigChange[];
  at: number;
}

/** What happened to a version of the config file. */
export interface ConfigEvent {
  outcome: 'applied' | 'pending' | 'rejected';
  sha: string;
  /** Who confirmed or rejected it; absent when it applied on its own. */
  by?: string;
  changes: ConfigChange[];
}

export type Review =
  | { status: 'invalid'; issues: string[] }
  /** Nothing applied yet, nothing widens, or the file is what was applied. */
  | { status: 'apply'; config: BridgeConfig; changes: ConfigChange[] }
  | { status: 'confirm'; config: BridgeConfig; changes: ConfigChange[]; running: BridgeConfig };

/**
 * What a config file's text means against the applied one. Throws when the applied record exists but is not a
 * valid config (this version's schema rejects it): there is nothing to measure against, so only an owner
 * confirming the whole file (`bridge check --apply`) moves on.
 */
export function review(text: string, applied: string | undefined): Review {
  const next = checkConfig(text);
  if (!next.config) return { status: 'invalid', issues: next.issues.map(formatIssue) };
  if (applied === undefined) return { status: 'apply', config: next.config, changes: [] };
  const running = checkConfig(applied).config;
  if (!running) throw new Error(UNREADABLE_RECORD);
  const changes = configChanges(running, next.config);
  return changes.some((c) => c.widens)
    ? { status: 'confirm', config: next.config, changes, running }
    : { status: 'apply', config: next.config, changes };
}

/**
 * Applies the config file as it changes: at once when nothing widens access, otherwise only after an owner
 * confirms (`confirm`, from the CLI, the dashboard or an IM button). A rejected or superseded change is never
 * applied; editing the file again starts a new review.
 */
export class ConfigGate {
  private readonly path: string;
  private readonly applied: AppliedConfig;
  private readonly apply: (cfg: BridgeConfig) => void;
  private readonly log: (line: string) => void;
  /** Called when a change starts waiting; `signal` aborts once it is decided or superseded. */
  private readonly onPending: (pending: PendingConfig, signal: AbortSignal) => void;
  private audit?: (event: ConfigEvent) => void;
  /** Events from before the audit trail was attached (the config applied while starting). */
  private queued: ConfigEvent[] = [];
  private current?: { pending: PendingConfig; done: AbortController };
  private rejected?: string;

  constructor(opts: {
    path: string;
    applied: AppliedConfig;
    apply: (cfg: BridgeConfig) => void;
    log: (line: string) => void;
    onPending?: (pending: PendingConfig, signal: AbortSignal) => void;
  }) {
    this.path = opts.path;
    this.applied = opts.applied;
    this.apply = opts.apply;
    this.log = opts.log;
    this.onPending = opts.onPending ?? (() => {});
  }

  /** Where events go once the audit trail is open (it lives in the data dir the config names). */
  onAudit(audit: (event: ConfigEvent) => void) {
    this.audit = audit;
    for (const e of this.queued.splice(0)) audit(e);
  }

  private record(event: ConfigEvent) {
    if (this.audit) this.audit(event);
    else this.queued.push(event);
  }

  /** The config to start with: the file if it may apply now, else the one applied last. Call `offer` once running. */
  initial(): BridgeConfig {
    const text = readFileSync(this.path, 'utf8');
    const before = this.applied.read();
    const r = review(text, before);
    if (r.status === 'invalid') throw new Error(`bridge.yaml is invalid:\n  - ${r.issues.join('\n  - ')}`);
    if (r.status === 'confirm') return r.running;
    if (text !== before) {
      this.applied.write(text);
      this.record({ outcome: 'applied', sha: configSha(text), changes: r.changes });
    }
    return r.config;
  }

  pending(): PendingConfig | undefined {
    return this.current?.pending;
  }

  /** The file changed: apply it, or hold it for an owner. */
  offer() {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      this.log(`config not reloaded: ${(err as Error).message}`);
      return;
    }
    const sha = configSha(text);
    if (this.current?.pending.sha === sha || this.rejected === sha) return;
    const applied = this.applied.read();
    let r: Review;
    try {
      r = review(text, applied);
    } catch (err) {
      this.log(`config not reloaded: ${(err as Error).message}`);
      return;
    }
    if (r.status === 'invalid') {
      this.settle('the file changed again');
      this.log(`config not reloaded (keeping the running one):\n  - ${r.issues.join('\n  - ')}`);
      return;
    }
    if (r.status === 'apply') {
      this.settle('the file changed again');
      if (r.changes.length || text !== applied) {
        this.apply(r.config);
        this.applied.write(text);
        this.record({ outcome: 'applied', sha, changes: r.changes });
        this.log(`config reloaded${r.changes.length ? ` (${r.changes.length} change${r.changes.length > 1 ? 's' : ''})` : ''}`);
      }
      return;
    }
    this.settle('the file changed again');
    const pending: PendingConfig = { sha, changes: r.changes, at: Date.now() };
    const done = new AbortController();
    this.current = { pending, done };
    this.record({ outcome: 'pending', sha, changes: r.changes });
    this.log(`config change ${sha} widens access and waits for an owner: bridge check --apply, the dashboard, or the IM buttons`);
    this.onPending(pending, done.signal);
  }

  /**
   * An owner approved the file whose text has `sha`. Refused when the file has changed since (the owner saw
   * other changes than the ones that would apply).
   */
  confirm(sha: string, by: string): ConfigChange[] {
    const text = readFileSync(this.path, 'utf8');
    if (configSha(text) !== sha) throw new Error('bridge.yaml has changed since — review it again');
    const next = checkConfig(text);
    if (!next.config) throw new Error(`bridge.yaml is invalid:\n  - ${next.issues.map(formatIssue).join('\n  - ')}`);
    // The owner confirms the whole file, so an unreadable record only means the changes can't be listed.
    const runningText = this.applied.read();
    const running = runningText === undefined ? undefined : checkConfig(runningText).config;
    const changes = running ? configChanges(running, next.config) : [];
    this.apply(next.config);
    this.applied.write(text);
    this.rejected = undefined;
    this.record({ outcome: 'applied', sha, by, changes });
    this.settle(`applied by ${by}`);
    this.log(`config change ${sha} applied by ${by}`);
    return changes;
  }

  /** An owner turned the pending change down: it stays unapplied until the file changes again. */
  reject(sha: string, by: string) {
    if (this.current?.pending.sha !== sha) throw new Error('that change is no longer pending');
    this.rejected = sha;
    this.record({ outcome: 'rejected', sha, by, changes: this.current.pending.changes });
    this.settle(`rejected by ${by}`);
    this.log(`config change ${sha} rejected by ${by}; the running config stays`);
  }

  private settle(reason: string) {
    if (!this.current) return;
    this.current.done.abort(new Error(reason));
    this.current = undefined;
  }
}

/** How long the IM buttons for a pending config change stay open (the change itself waits until decided). */
const ASK_OWNERS_MS = 24 * 3600_000;

/**
 * Ask every owner of the running config, in their direct messages with the bot, to apply or reject a pending
 * change. Whichever answer comes first (here, on the dashboard or from `bridge check --apply`) settles it
 * everywhere: the gate aborts `signal`, which withdraws the other questions.
 */
export async function askOwners(bridge: Bridge, running: BridgeConfig, gate: ConfigGate, pending: PendingConfig, signal: AbortSignal) {
  const owners = Object.entries(running.people).filter(([, p]) => p.trust === 'owner').map(([id]) => id);
  const asked = await bridge.askInDms({
    people: owners,
    text: [
      `⚙️ bridge.yaml changed in a way that widens access (${pending.sha}). Apply it?`,
      ...describeChanges(pending.changes),
      '("+" widens access, "-" narrows it, "~" neither)',
    ].join('\n'),
    choices: [
      { label: 'Apply', value: 'apply', style: 'primary' },
      { label: 'Reject', value: 'reject', style: 'danger' },
    ],
    typedHint: 'Reply "apply" or "reject".',
    typed: (t) => (/^apply$/i.test(t) ? 'apply' : /^reject$/i.test(t) ? 'reject' : undefined),
    // Decided here: apply or reject now, so the message shows what really happened.
    outcome: (r) => {
      if (!r) return '⌛ No answer — the change still waits: bridge check --apply, or the dashboard.';
      try {
        if (r.value === 'reject') {
          gate.reject(pending.sha, r.by);
          return `✖ Rejected by ${r.by}; the running config stays.`;
        }
        gate.confirm(pending.sha, r.by);
        return `✅ Applied by ${r.by}.`;
      } catch (err) {
        return `⚠️ Not applied: ${(err as Error).message}`;
      }
    },
    timeoutMs: ASK_OWNERS_MS,
    signal,
  });
  return asked;
}
