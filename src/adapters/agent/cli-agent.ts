import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentReply, AgentTurn, Workspace } from './types.ts';
import { terminateTree } from './process-tree.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import { sessionSlug } from '../../core/address.ts';
import {
  ensureWorktree,
  expandHome,
  mergeBlocker,
  prBlocker,
  pruneIdle,
  pushPullRequest,
  removeWorktree,
  squashMerge,
  worktreeStatus,
  type WorktreeOpts,
  type WorktreeStatus,
} from './worktree.ts';

/** What the bridge tells a coding agent about where it is, added to the agent's own instructions. */
const BRIDGE_PROMPT = `You are being reached through bridge. Messages come from people in a chat app (Slack, Telegram, …) or from other agents.
- Your final answer is posted back to the conversation automatically.
- Use the "bridge" MCP tools to post an interim update (send_message), ask the person a question and wait for the reply (ask_human), hand work to another agent (delegate), or call the external tools you were granted.
- Keep chat replies short and readable; the conversation is a chat thread, not a terminal.
- Reply in the language of the person's own message, even when bridge notes like this one, attached files, screenshots or tool output are in another language. If their message has no words, use the language of their earlier messages.`;

/** The settings every coding-agent CLI shares (claude-code, codex). */
export interface CliAgentConfig {
  cwd?: string;
  /** The executable. */
  command: string;
  /** Give every conversation its own git worktree + branch. */
  worktree: boolean;
  worktree_dir: string;
  worktree_links: string[];
  git_token?: string;
}

/** One run of the CLI: its arguments, what goes to its stdin, and what to remove afterwards. */
export interface CliInvocation {
  args: string[];
  stdin: string;
  /** The process's environment (default: the bridge's). */
  env?: NodeJS.ProcessEnv;
  cleanup?: () => void;
}

/** Reads one turn's output, one JSON event per line, and says how the turn ended. */
export interface CliOutput {
  /** One parsed line of output. Report the agent's session id as soon as it is known with `sessionId`. */
  event(ev: any, sessionId: (id: string) => void): void;
  /** The reply, once the CLI has given one. */
  result(): AgentReply | undefined;
  /** Why the turn failed when the CLI exits without a reply, beyond what it wrote to stderr. */
  failure?(): string | undefined;
}

/**
 * A coding agent run as a CLI per turn (Claude Code, Codex), resuming its own session across the turns of a
 * conversation. Optionally gives each conversation its own git worktree, with status / merge / discard / pr.
 * A turn's process runs in its own process group: stopping the turn also stops the commands it started.
 */
export abstract class CliAgent implements AgentAdapter {
  readonly name: string;
  private readonly base: CliAgentConfig;
  /** Running processes and a promise that settles when each has closed. */
  private readonly running = new Map<ChildProcess, Promise<void>>();
  private readonly locks = new KeyedLock();
  /** Worktrees (by session slug) a turn is running in: never pruned. */
  private readonly busy = new Map<string, number>();
  readonly workspace?: Workspace;

  /** The CLI's name in error messages ("claude exited: …"). */
  protected abstract readonly label: string;
  /** How to run one turn in `cwd`, resuming the CLI's session `resume` when given. */
  protected abstract invocation(cwd: string, turn: AgentTurn, instructions: string, resume: string | undefined): CliInvocation;
  /** A reader for one turn's output. */
  protected abstract output(turn: AgentTurn): CliOutput;

  constructor(name: string, cfg: CliAgentConfig, secrets: SecretResolver) {
    this.name = name;
    this.base = cfg;
    if (cfg.worktree) {
      // The token is resolved when a PR is pushed, so a secret stored later is picked up.
      const gitToken = cfg.git_token;
      const token = gitToken === undefined ? undefined : () => secrets(gitToken);
      this.workspace = new WorktreeWorkspace(this.worktreeOpts.bind(this), token, (key, fn) => this.locks.run(sessionSlug(key), fn), async (slug, fn) =>
        this.locks.run(slug, async () => {
          if (!this.busy.get(slug)) await fn();
        }),
      );
    }
  }

  private worktreeOpts(sessionKey: string): WorktreeOpts {
    return {
      baseCwd: expandHome(this.base.cwd ?? process.cwd()),
      sessionKey,
      dir: this.base.worktree_dir,
      links: this.base.worktree_links,
    };
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
    if (!this.base.worktree) return this.runIn(expandHome(this.base.cwd ?? process.cwd()), turn, BRIDGE_PROMPT);
    const slug = sessionSlug(turn.envelope.sessionKey);
    // Under the lock, so a prune or discard can't remove the worktree between creating and using it.
    const wt = await this.locks.run(slug, async () => {
      const w = await ensureWorktree(this.worktreeOpts(turn.envelope.sessionKey));
      this.busy.set(slug, (this.busy.get(slug) ?? 0) + 1);
      return w;
    });
    try {
      if (wt.notice) turn.onNotice?.(wt.notice);
      if (wt.created) turn.onNotice?.(`🌿 ${this.name} works on its own branch \`${wt.branch}\` for this conversation (${wt.path}).`);
      const instructions = `${BRIDGE_PROMPT}\n- You are working in your own git worktree (${wt.path}) on branch ${wt.branch}, separate from the user's main checkout. Stay on this branch and commit your changes here when a piece of work is done; the user merges the branch.`;
      return await this.runIn(wt.cwd, turn, instructions);
    } finally {
      const n = (this.busy.get(slug) ?? 1) - 1;
      if (n) this.busy.set(slug, n);
      else this.busy.delete(slug);
    }
  }

  private async runIn(cwd: string, turn: AgentTurn, instructions: string): Promise<AgentReply> {
    const resume = turn.agentSessionId && resumableIn(turn.agentSessionId, cwd);
    const inv = this.invocation(cwd, turn, instructions, resume);
    try {
      return await this.spawnTurn(cwd, inv, turn);
    } finally {
      inv.cleanup?.();
    }
  }

  private spawnTurn(cwd: string, inv: CliInvocation, turn: AgentTurn): Promise<AgentReply> {
    const signal = turn.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const output = this.output(turn);
    return new Promise<AgentReply>((resolve, reject) => {
      // Its own process group and session; stopping it also stops the commands it started (see terminateTree).
      const child = spawn(this.base.command, inv.args, { cwd, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let markClosed!: () => void;
      const closed = new Promise<void>((r) => (markClosed = r));
      this.running.set(child, closed);
      const onAbort = () => void this.terminate(child, closed);
      signal?.addEventListener('abort', onAbort, { once: true });

      let sessionId: string | undefined;
      const onSessionId = (id: string) => {
        if (id === sessionId) return;
        sessionId = id;
        turn.onSessionId?.(encodeSessionId(id, cwd));
      };
      let stderr = '';
      let stdinError: Error | undefined;
      let spawnError: Error | undefined;
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        this.running.delete(child);
        markClosed();
        const result = output.result();
        if (signal?.aborted) reject(abortError(signal));
        else if (result) {
          const id = result.agentSessionId ?? sessionId;
          resolve({ ...result, agentSessionId: id && encodeSessionId(id, cwd) });
        }
        else if (spawnError) reject(spawnError);
        else {
          const why = output.failure?.() ?? stderr.trim();
          const detail = why ? `: ${why}` : stdinError ? ` before reading its prompt (${stdinError.message})` : '';
          reject(new Error(`${this.label} exited${detail}`));
        }
      };
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      createInterface({ input: child.stdout }).on('line', (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        output.event(ev, onSessionId);
      });
      child.on('error', (err) => {
        spawnError = err;
        // A process that never started emits no 'close'.
        if (child.pid === undefined) finish();
      });
      child.on('close', finish);
      // EPIPE when the CLI exits without reading the prompt: 'close' reports it.
      child.stdin.on('error', (err) => (stdinError = err));
      child.stdin.end(inv.stdin);
    });
  }

  /** SIGTERM the CLI and the commands it runs, SIGKILL what is left after the grace period; resolves once closed. */
  private async terminate(child: ChildProcess, closed: Promise<void>) {
    if (child.pid === undefined) return closed;
    await terminateTree(child.pid, closed);
  }

  /** Bridge shutdown: end running turns (and their tools) so they can't keep editing while a resumed turn starts. */
  async stop() {
    await Promise.all([...this.running].map(([child, closed]) => this.terminate(child, closed)));
  }
}

/**
 * CLIs keep their sessions per directory, so the session id the bridge stores also names the
 * directory the session ran in: `<session id>@<dir tag>`. A session is resumed only in the same directory.
 */
function encodeSessionId(id: string, cwd: string): string {
  return `${id}@${dirTag(cwd)}`;
}

/** The CLI's session id in `stored`, if it ran in `cwd`. */
function resumableIn(stored: string, cwd: string): string | undefined {
  const at = stored.lastIndexOf('@');
  return at > 0 && stored.slice(at + 1) === dirTag(cwd) ? stored.slice(0, at) : undefined;
}

const dirTag = (cwd: string) => createHash('sha1').update(cwd).digest('hex').slice(0, 12);

/** Serializes work per key (a conversation's worktree): creating, pruning, merging, discarding. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** The prompt, plus where the attached files are, for agents that read files from disk. */
export function withFiles(turn: AgentTurn, howToRead: string): string {
  if (!turn.files?.length) return turn.text;
  const list = turn.files.map((f) => `- ${f.path} (${f.name}${f.mime ? `, ${f.mime}` : ''})`).join('\n');
  return `${turn.text || 'See the attached files.'}\n\n[Attached by the person — ${howToRead}]\n${list}`;
}

/** "Read src/x.ts": a tool name and its main argument, shortened. */
export function shortStep(name: string, target: unknown): string {
  const short = typeof target === 'string' ? ` ${target.length > 60 ? target.slice(0, 57) + '…' : target}` : '';
  return `${name}${short}`;
}

/** status / merge / discard for a conversation's `bridge/…` branch. */
class WorktreeWorkspace implements Workspace {
  private readonly opts: (sessionKey: string) => WorktreeOpts;
  /** Runs fn under the conversation's worktree lock. */
  private readonly locked: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>;
  /** Runs fn under the slug's lock, unless a turn is running in that worktree. */
  private readonly pruneGuard: (slug: string, fn: () => Promise<void>) => Promise<void>;
  readonly previewPr?: Workspace['previewPr'];
  readonly pr?: Workspace['pr'];

  constructor(
    opts: (sessionKey: string) => WorktreeOpts,
    gitToken: (() => string) | undefined,
    locked: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>,
    pruneGuard: (slug: string, fn: () => Promise<void>) => Promise<void>,
  ) {
    this.opts = opts;
    this.locked = locked;
    this.pruneGuard = pruneGuard;
    if (gitToken) {
      this.previewPr = (key) =>
        this.locked(key, async () => {
          const o = this.opts(key);
          const st = await worktreeStatus(o);
          if (!st) return { ok: false as const, reason: 'this conversation has no branch yet' };
          const blocker = await prBlocker(o, st);
          if (blocker) return { ok: false as const, reason: `can't open a PR: ${blocker}` };
          return {
            ok: true as const,
            summary: `Push \`${st.branch}\` (${st.commits?.length} commit(s)) to origin and open a pull request into \`${st.base}\`:\n${commitList(st)}`,
          };
        });
      this.pr = (key) =>
        this.locked(key, async () => {
          const { url, created } = await pushPullRequest(this.opts(key), gitToken());
          return created ? `🔀 Opened ${url}` : `🔀 Pushed new commits to the open PR ${url}`;
        });
    }
  }

  status(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      return st && describe(st);
    });
  }

  previewMerge(key: string) {
    return this.locked(key, async () => {
      const o = this.opts(key);
      const st = await worktreeStatus(o);
      if (!st) return { ok: false as const, reason: 'this conversation has no branch yet' };
      const blocker = await mergeBlocker(o, st);
      if (blocker) return { ok: false as const, reason: `can't merge: ${blocker}` };
      return {
        ok: true as const,
        summary: `Squash ${st.commits?.length} commit(s) from \`${st.branch}\` into \`${st.base}\` as one commit:\n${commitList(st)}\n${fence(st.diffstat)}`,
      };
    });
  }

  merge(key: string) {
    return this.locked(key, async () => {
      const { commit, message } = await squashMerge(this.opts(key));
      return `✅ Merged into one commit \`${commit}\` — ${message.split('\n')[0]}. The branch and its worktree are removed; your next message starts fresh from the updated base.`;
    });
  }

  previewDiscard(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      if (!st) return undefined;
      const lost = [
        st.commits === undefined
          ? `the branch \`${st.branch}\`, whose unmerged commits can't be determined (${st.note})`
          : st.commits.length
            ? `${st.commits.length} unmerged commit(s):\n${commitList(st)}`
            : '',
        st.dirty.length ? `${st.dirty.length} uncommitted file(s)` : '',
      ].filter(Boolean);
      return lost.join('\n');
    });
  }

  prune(isIdle: (slug: string) => boolean) {
    return pruneIdle(this.opts(''), isIdle, { guard: this.pruneGuard });
  }

  discard(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      await removeWorktree(this.opts(key));
      return `🗑 Discarded ${st ? `\`${st.branch}\`` : 'the branch'}. Your next message starts fresh.`;
    });
  }
}

function describe(st: WorktreeStatus): string {
  const lines = [`🌿 \`${st.branch}\` (from \`${st.base}\`)`];
  if (st.commits === undefined) lines.push(`⚠️ Can't tell which commits are unmerged: ${st.note}.`);
  else {
    if (st.note) lines.push(`⚠️ Note: ${st.note}.`);
    lines.push(st.commits.length ? `${st.commits.length} commit(s) not in ${st.base}:\n${commitList(st)}` : `No commits beyond ${st.base} yet.`);
  }
  if (st.diffstat) lines.push(fence(st.diffstat));
  if (st.dirty.length) lines.push(`Uncommitted: ${st.dirty.map((d) => d.slice(3)).join(', ')}`);
  return lines.join('\n');
}

function commitList(st: WorktreeStatus) {
  const commits = st.commits ?? [];
  const shown = commits.slice(0, 10).map((c) => `• ${c}`);
  if (commits.length > 10) shown.push(`• … and ${commits.length - 10} more`);
  return shown.join('\n');
}

function fence(s: string) {
  return s ? '```\n' + s + '\n```' : '';
}
