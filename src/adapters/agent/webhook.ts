import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';
import { agentEvent, turnMessage } from './protocol.ts';

type WebhookConfig = Extract<AgentConfig, { type: 'webhook' }>;

/**
 * Any HTTP service is an agent: the bridge POSTs the turn message of protocol.ts, and the service answers with
 * the reply as JSON ({"text","session_id"?,"cost_usd"?}), or as a `text/event-stream` of protocol.ts messages
 * (progress and the session id while it works, then the reply or an error).
 */
export class WebhookAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: WebhookConfig;

  private readonly secrets: SecretResolver;

  constructor(name: string, cfg: WebhookConfig, secrets: SecretResolver) {
    this.name = name;
    this.cfg = cfg;
    this.secrets = secrets;
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const [k, v] of Object.entries(this.cfg.headers)) headers[k] = this.secrets(v);
    const timeout = AbortSignal.timeout(parseDuration(this.cfg.timeout));
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers,
      signal: turn.signal ? AbortSignal.any([turn.signal, timeout]) : timeout,
      body: JSON.stringify(turnMessage(turn)),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    if (/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) return this.readStream(res, turn);
    const ev = agentEvent({ type: 'reply', ...((await res.json()) as Record<string, unknown>) }, turn.agentSessionId, this.name);
    if (ev?.type !== 'reply') throw new Error(ev?.type === 'error' ? ev.message : `${this.name}: no reply`);
    return ev.reply;
  }

  /** Reads events until a reply or an error; a stream that ends without either fails the turn. */
  private async readStream(res: Response, turn: AgentTurn): Promise<AgentReply> {
    if (!res.body) throw new Error(`${this.name}: event stream has no body`);
    let sessionId = turn.agentSessionId;
    try {
      for await (const data of sseData(res.body)) {
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          throw new Error(`${this.name}: event is not JSON: ${data.slice(0, 200)}`);
        }
        if (typeof msg !== 'object' || msg === null) continue;
        const ev = agentEvent(msg as Record<string, unknown>, sessionId, this.name);
        if (ev?.type === 'progress') turn.onProgress?.(ev.text);
        else if (ev?.type === 'session') {
          sessionId = ev.id;
          turn.onSessionId?.(ev.id);
        } else if (ev?.type === 'reply') return ev.reply;
        else if (ev?.type === 'error') throw new Error(ev.message);
      }
    } finally {
      // Returning early (or failing) closes the connection rather than leaving it to the server.
      await res.body.cancel().catch(() => {});
    }
    throw new Error(`${this.name}: event stream ended without a reply`);
  }
}

/** The `data` of each server-sent event (multi-line data joined with "\n"); comments and other fields are skipped. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Lines end with \r\n, \n or \r; keep a trailing partial line (or a lone \r that may precede \n) for later.
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = done ? '' : lines.pop()!;
      if (done && lines.at(-1) === '') lines.pop();
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
      }
      if (done) {
        if (data.length) yield data.join('\n'); // an event the server didn't end with a blank line
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
