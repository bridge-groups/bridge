import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';

type WebhookConfig = Extract<AgentConfig, { type: 'webhook' }>;

/**
 * Any HTTP service is an agent:
 *   POST <url>  {"type":"turn","text":…,"session_id":…,"envelope":{…},"mcp":{"url":…}}
 *   →  200      {"text":"…","session_id":"…","cost_usd":0.01}
 * or, to report progress while it works, a `text/event-stream` whose events carry the stdio agent's lines:
 *   data: {"type":"progress","text":"Reading the logs"}
 *   data: {"type":"session","session_id":"…"}
 *   data: {"type":"reply","text":"…","session_id":"…","cost_usd":0.01}   (or {"type":"error","message":"…"})
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
      body: JSON.stringify({
        type: 'turn',
        text: turn.text,
        session_id: turn.agentSessionId ?? null,
        budget_usd: turn.budgetUsd ?? null,
        files: turn.files ?? [],
        envelope: turn.envelope,
        mcp: { url: turn.mcp.url },
      }),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    if (/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) return this.readStream(res, turn);
    return this.reply((await res.json()) as Record<string, unknown>, turn);
  }

  private reply(body: Record<string, unknown>, turn: AgentTurn): AgentReply {
    if (typeof body.text !== 'string') throw new Error(`${this.name}: response has no "text" string`);
    return {
      text: body.text,
      agentSessionId: typeof body.session_id === 'string' ? body.session_id : turn.agentSessionId,
      costUsd: typeof body.cost_usd === 'number' ? body.cost_usd : undefined,
    };
  }

  /** Reads events until a reply or an error; a stream that ends without either fails the turn. */
  private async readStream(res: Response, turn: AgentTurn): Promise<AgentReply> {
    if (!res.body) throw new Error(`${this.name}: event stream has no body`);
    let sessionId = turn.agentSessionId;
    try {
      for await (const data of sseData(res.body)) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new Error(`${this.name}: event is not JSON: ${data.slice(0, 200)}`);
        }
        if (ev.type === 'progress' && typeof ev.text === 'string') turn.onProgress?.(ev.text);
        else if (ev.type === 'session' && typeof ev.session_id === 'string') {
          sessionId = ev.session_id;
          turn.onSessionId?.(sessionId);
        } else if (ev.type === 'reply') return this.reply({ session_id: sessionId, ...ev }, turn);
        else if (ev.type === 'error') throw new Error(`${this.name}: ${typeof ev.message === 'string' ? ev.message : 'agent failed'}`);
        // Unknown event types are for newer bridges; skip them.
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
