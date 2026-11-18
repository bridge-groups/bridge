import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';
import { terminateTree } from './process-tree.ts';

type StdioConfig = Extract<AgentConfig, { type: 'stdio' }>;

interface Pending {
  resolve: (r: AgentReply) => void;
  reject: (e: Error) => void;
  turn: AgentTurn;
  /** The process this turn was sent to. */
  child: ChildProcessWithoutNullStreams;
}

/**
 * A long-running local process speaking JSON lines.
 *   bridge → agent  {"type":"turn","id":…,"text":…,"session_id":…,"envelope":{…},"mcp":{"url":…}}
 *                   {"type":"cancel","id":…}   (the turn was stopped or timed out; its reply is no longer read)
 *   agent → bridge  {"type":"progress","id":…,"text":"…"}
 *                   {"type":"reply","id":…,"text":"…","session_id":"…","cost_usd":0}
 *                   {"type":"error","id":…,"message":"…"}
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
        child,
        resolve: (r) => (settle(), resolve(r)),
        reject: (e) => (settle(), reject(e)),
      });
      this.write(child, {
        type: 'turn',
        id,
        text: turn.text,
        session_id: turn.agentSessionId ?? null,
        budget_usd: turn.budgetUsd ?? null,
        files: turn.files ?? [],
        envelope: turn.envelope,
        mcp: { url: turn.mcp.url },
      });
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
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    if (msg.type === 'progress') p.turn.onProgress?.(String(msg.text ?? ''));
    else if (msg.type === 'reply') {
      p.resolve({
        text: String(msg.text ?? ''),
        agentSessionId: typeof msg.session_id === 'string' ? msg.session_id : p.turn.agentSessionId,
        costUsd: typeof msg.cost_usd === 'number' ? msg.cost_usd : undefined,
      });
    } else if (msg.type === 'error') {
      p.reject(new Error(String(msg.message ?? 'agent error')));
    }
  }
}
