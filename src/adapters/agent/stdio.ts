import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';
import { terminateTree } from './process-tree.ts';
import { agentEvent, turnMessage } from './protocol.ts';

type StdioConfig = Extract<AgentConfig, { type: 'stdio' }>;

interface Pending {
  resolve: (r: AgentReply) => void;
  reject: (e: Error) => void;
  turn: AgentTurn;
  /** The agent's session id as the turn knows it so far. */
  sessionId?: string;
  /** The process this turn was sent to. */
  child: ChildProcessWithoutNullStreams;
}

/**
 * A long-running local process speaking JSON lines: the messages of protocol.ts, each with the turn's `id`, plus
 * {"type":"cancel","id"} from the bridge when a turn is stopped or times out (its reply is no longer read).
 */
export class StdioAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: StdioConfig;
  private child?: ChildProcessWithoutNullStreams;
  /** Resolves when the process has exited. */
  private readonly exited = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
  private readonly pending = new Map<string, Pending>();

  private readonly secrets: SecretResolver;

  constructor(name: string, cfg: StdioConfig, secrets: SecretResolver) {
    this.name = name;
    this.cfg = cfg;
    this.secrets = secrets;
  }

  run(turn: AgentTurn): Promise<AgentReply> {
    const signal = turn.signal;
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const child = this.ensureChild();
    const id = randomUUID();
    const timeoutMs = parseDuration(this.cfg.timeout);
    return new Promise<AgentReply>((resolve, reject) => {
      // Whichever way the turn ends, the timer and the abort listener go with it.
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const cancel = (why: Error) => {
        if (!this.pending.has(id)) return;
        settle();
        this.write(child, { type: 'cancel', id });
        reject(why);
      };
      const onAbort = () => cancel(new Error('aborted'));
      const timer = setTimeout(() => cancel(new Error(`${this.name} gave no reply within ${this.cfg.timeout}`)), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        turn,
        sessionId: turn.agentSessionId,
        child,
        resolve: (r) => (settle(), resolve(r)),
        reject: (e) => (settle(), reject(e)),
      });
      this.write(child, { ...turnMessage(turn), id });
    });
  }

  /** End the agent process and what it started: SIGTERM, then SIGKILL after the grace period. */
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (child) await this.terminate(child);
  }

  private async terminate(child: ChildProcessWithoutNullStreams) {
    const exited = this.exited.get(child);
    if (child.pid === undefined || !exited) return;
    await terminateTree(child.pid, exited);
  }

  private write(child: ChildProcessWithoutNullStreams, msg: object) {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Every turn sent to `child` fails; it is done for (it may still be running, but can't be talked to). */
  private failAll(child: ChildProcessWithoutNullStreams, err: Error) {
    for (const p of [...this.pending.values()]) if (p.child === child) p.reject(err);
    if (this.child === child) this.child = undefined;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && this.child.stdin.writable) return this.child;
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(this.cfg.env)) env[k] = this.secrets(v);
    // Its own process group, so stopping it reaches what it started.
    const child = spawn(this.cfg.command, this.cfg.args, { cwd: this.cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.exited.set(child, new Promise((resolve) => child.once('close', () => resolve())));
    child.stderr.on('data', (d) => process.stderr.write(`[${this.name}] ${d}`));
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('exit', (code) => this.failAll(child, new Error(`${this.name} exited (code ${code})`)));
    child.on('error', (err) => this.failAll(child, err));
    // EPIPE: the agent closed its stdin. Without this listener the error would crash the bridge.
    child.stdin.on('error', (err) => {
      this.failAll(child, new Error(`${this.name} stopped reading its input (${err.message})`));
      void this.terminate(child);
    });
    this.child = child;
    return child;
  }

  private onLine(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol line (a stray log line)
    }
    if (typeof msg !== 'object' || msg === null) return;
    const p = this.pending.get(String((msg as { id?: unknown }).id));
    if (!p) return;
    const ev = agentEvent(msg as Record<string, unknown>, p.sessionId, this.name);
    if (ev?.type === 'progress') p.turn.onProgress?.(ev.text);
    else if (ev?.type === 'session') {
      p.sessionId = ev.id;
      p.turn.onSessionId?.(ev.id);
    } else if (ev?.type === 'reply') p.resolve(ev.reply);
    else if (ev?.type === 'error') p.reject(new Error(ev.message));
  }
}
