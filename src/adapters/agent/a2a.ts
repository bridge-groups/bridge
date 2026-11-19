import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import { resolveTemplate, type SecretResolver } from '../../core/secrets.ts';
import { ShuttingDown, type AgentAdapter, type AgentReply, type AgentTurn } from './types.ts';
import { sseData } from './webhook.ts';

type A2aConfig = Extract<AgentConfig, { type: 'a2a' }>;

/** The A2A versions this client speaks, preferred first. */
const VERSIONS = ['1.0', '0.3'] as const;
type Version = (typeof VERSIONS)[number];

/** JSON-RPC method names: 1.0 took gRPC's names, 0.3 used paths. */
const METHODS = {
  '1.0': { send: 'SendMessage', stream: 'SendStreamingMessage', get: 'GetTask', cancel: 'CancelTask', subscribe: 'SubscribeToTask' },
  '0.3': { send: 'message/send', stream: 'message/stream', get: 'tasks/get', cancel: 'tasks/cancel', subscribe: 'tasks/resubscribe' },
} as const;
type Method = keyof (typeof METHODS)['1.0'];

const TASK_NOT_FOUND = -32001;
/** A task that neither streams nor answers at once is asked about again after 0.5s, 1s, 2s… up to every 10s. */
const POLL_FIRST_MS = 500;
const POLL_MAX_MS = 10_000;
/** How long a card fetch or a cancel request may take. */
const SIDE_REQUEST_MS = 30_000;
/** Remote error text is quoted into chat messages; it is cut to this length. */
const MAX_ERROR_CHARS = 500;

/** Where the agent takes JSON-RPC requests, as its agent card says. */
export interface A2aEndpoint {
  url: string;
  version: Version;
  streaming: boolean;
}

type State = 'submitted' | 'working' | 'input-required' | 'auth-required' | 'completed' | 'failed' | 'canceled' | 'rejected' | 'unknown';
const STATES: readonly State[] = ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'];
/** States in which the task waits for nothing more from this turn. */
const SETTLED: ReadonlySet<State> = new Set(['input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected']);

interface Part {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  filename?: string;
}

interface TaskView {
  id: string;
  state: State;
  /** The status message: progress while working, the question when input is required, the reason it failed. */
  status: Part[];
  artifacts: Map<string, Part[]>;
}

type Event =
  | { kind: 'task'; contextId?: string; task: TaskView }
  | { kind: 'message'; contextId?: string; parts: Part[] }
  | { kind: 'status'; contextId?: string; taskId: string; state: State; parts: Part[] }
  | { kind: 'artifact'; taskId: string; artifactId: string; parts: Part[]; append: boolean };

/**
 * What the bridge keeps as this agent's session id between turns, as JSON. `open` names a task the conversation
 * is still in: `running` while a turn waits on it (a turn cut off by a restart rejoins it), `input` when it waits
 * for the next message (input-required or auth-required).
 */
interface Session {
  contextId?: string;
  taskId?: string;
  open?: 'running' | 'input';
}

class RpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/**
 * A remote agent speaking A2A (Agent2Agent, https://a2a-protocol.org), versions 1.0 and 0.3, over JSON-RPC. The
 * agent card names the endpoint, its protocol version and whether it streams; the endpoint must be on the card's
 * own origin, so the configured headers only ever go to the host written in bridge.yaml.
 *
 * A bridge conversation is one A2A context; each turn sends one message and waits until its task completes, fails
 * or needs input. A question (input-required) is the turn's reply, and the next message answers it in the same
 * task. A stopped or timed-out turn cancels its task; one cut off by a bridge shutdown leaves it running and
 * rejoins it on the next start.
 */
export class A2aAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: A2aConfig;
  private readonly secrets: SecretResolver;
  private found?: Promise<A2aEndpoint>;

  constructor(name: string, cfg: A2aConfig, secrets: SecretResolver) {
    this.name = name;
    this.cfg = cfg;
    this.secrets = secrets;
  }

  /** The endpoint from the agent card, read on first use and kept until a turn fails. */
  endpoint(signal?: AbortSignal): Promise<A2aEndpoint> {
    if (!this.found) {
      const p = this.readCard(signal);
      this.found = p;
      p.catch(() => {
        if (this.found === p) this.found = undefined;
      });
    }
    return this.found;
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
    const timeout = AbortSignal.timeout(parseDuration(this.cfg.timeout));
    const signal = turn.signal ? AbortSignal.any([turn.signal, timeout]) : timeout;
    const session = parseSession(turn.agentSessionId);
    const tracker = new Tracker(session.contextId, turn.onProgress, (taskId, contextId) =>
      turn.onSessionId?.(JSON.stringify({ ...(contextId && { contextId }), taskId, open: 'running' } satisfies Session)),
    );
    let ep: A2aEndpoint | undefined;
    try {
      ep = await this.endpoint(signal);
      const rejoined = turn.resume && session.open === 'running' && session.taskId ? await this.rejoin(ep, session.taskId, tracker, signal) : false;
      if (!rejoined) await this.send(ep, turn, session, tracker, signal);
      return this.reply(tracker);
    } catch (err) {
      if (!signal.aborted) {
        this.found = undefined; // the card may have changed
        throw err;
      }
      const shutdown = turn.signal?.reason instanceof ShuttingDown;
      const reason: unknown = turn.signal?.reason;
      const why = !turn.signal?.aborted
        ? `no answer within ${this.cfg.timeout}`
        : reason instanceof Error && reason.name !== 'AbortError'
          ? reason.message
          : 'the turn was stopped';
      const task = tracker.task;
      // A shutdown leaves the task running: the turn resumes on the next start and rejoins it.
      const note = ep && task && !SETTLED.has(task.state) && !shutdown ? await this.cancel(ep, task.id) : '';
      throw new Error(`${this.name}: ${why}${note}`);
    }
  }

  private async readCard(signal?: AbortSignal): Promise<A2aEndpoint> {
    const cardUrl = cardLocation(this.cfg.url);
    const limit = AbortSignal.timeout(SIDE_REQUEST_MS);
    const res = await fetch(cardUrl, {
      headers: { ...this.headers(), accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    }).catch((err: Error) => {
      throw new Error(`${this.name}: agent card ${cardUrl} unreachable (${(err.cause as { code?: string })?.code ?? err.message})`);
    });
    if (!res.ok) throw new Error(`${this.name}: agent card ${cardUrl}: HTTP ${res.status}`);
    const card = await res.json().catch(() => undefined);
    const offer = isObj(card) ? jsonRpcInterface(card) : undefined;
    if (!offer) throw new Error(`${this.name}: the agent card at ${cardUrl} offers no JSON-RPC interface for A2A ${VERSIONS.join(' or ')}`);
    let url: URL;
    try {
      url = new URL(offer.url, cardUrl);
    } catch {
      throw new Error(`${this.name}: the agent card's interface URL is not a URL`);
    }
    const origin = new URL(cardUrl).origin;
    if (url.origin !== origin) {
      throw new Error(`${this.name}: the agent card sends requests to ${url.origin}, not ${origin}; the bridge only sends this agent's headers to the host in bridge.yaml`);
    }
    return { url: url.href, version: offer.version, streaming: isObj(card) && isObj(card.capabilities) && card.capabilities.streaming === true };
  }

  private headers(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.headers)) out[k] = resolveTemplate(v, this.secrets);
    return out;
  }

  private async send(ep: A2aEndpoint, turn: AgentTurn, session: Session, tracker: Tracker, signal: AbortSignal) {
    const files = await Promise.all(
      (turn.files ?? []).map(async (f) => ({ name: f.name, mime: f.mime, data: (await readFile(f.path)).toString('base64') })),
    );
    const message = outgoing(ep.version, turn.text, files, {
      contextId: session.contextId,
      taskId: session.open === 'input' ? session.taskId : undefined,
    });
    if (ep.streaming) await this.stream(ep, 'stream', { message }, tracker, signal);
    else {
      // Without streaming, ask for the task at once and poll it, so its id is known (and kept) while it runs.
      const configuration = ep.version === '1.0' ? { returnImmediately: true } : { blocking: false };
      tracker.apply(decodeEvent(await this.call(ep, 'send', { message, configuration }, signal)) ?? this.malformed());
    }
    if (!tracker.done) await this.poll(ep, tracker, signal);
  }

  /** Follow a task a cut-off turn left running; false when the agent no longer knows it. */
  private async rejoin(ep: A2aEndpoint, taskId: string, tracker: Tracker, signal: AbortSignal): Promise<boolean> {
    try {
      tracker.apply(taskEvent(await this.call(ep, 'get', { id: taskId }, signal)) ?? this.malformed());
    } catch (err) {
      if (err instanceof RpcError && err.code === TASK_NOT_FOUND) return false;
      throw err;
    }
    if (!tracker.done && ep.streaming) await this.stream(ep, 'subscribe', { id: taskId }, tracker, signal);
    if (!tracker.done) await this.poll(ep, tracker, signal);
    return true;
  }

  /** Read a streamed answer until the task settles or the stream ends; a plain JSON answer counts as one event. */
  private async stream(ep: A2aEndpoint, method: Method, params: object, tracker: Tracker, signal: AbortSignal) {
    const res = await this.post(ep, method, params, signal);
    if (!/^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
      tracker.apply(decodeEvent(this.result(await res.json().catch(() => undefined))) ?? this.malformed());
      return;
    }
    if (!res.body) throw new Error(`${this.name}: event stream has no body`);
    try {
      for await (const data of sseData(res.body)) {
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          throw new Error(`${this.name}: event is not JSON: ${data.slice(0, 200)}`);
        }
        const ev = decodeEvent(this.result(msg));
        if (ev) tracker.apply(ev);
        if (tracker.done) return;
      }
    } finally {
      // Returning early (or failing) closes the connection rather than leaving it to the server.
      await res.body.cancel().catch(() => {});
    }
  }

  private async poll(ep: A2aEndpoint, tracker: Tracker, signal: AbortSignal) {
    if (!tracker.task) throw new Error(`${this.name}: the answer ended without a task or message`);
    for (let wait = POLL_FIRST_MS; !tracker.done; wait = Math.min(wait * 2, POLL_MAX_MS)) {
      await sleep(wait, undefined, { signal });
      tracker.apply(taskEvent(await this.call(ep, 'get', { id: tracker.task.id }, signal)) ?? this.malformed());
    }
  }

  /** Cancel a task this turn gives up on; what went wrong is added to the turn's error, as there is no one else to tell. */
  private async cancel(ep: A2aEndpoint, taskId: string): Promise<string> {
    try {
      await this.call(ep, 'cancel', { id: taskId }, AbortSignal.timeout(SIDE_REQUEST_MS));
      return '';
    } catch (err) {
      return ` (cancelling its task ${taskId} failed: ${(err as Error).message})`;
    }
  }

  private async call(ep: A2aEndpoint, method: Method, params: object, signal: AbortSignal): Promise<unknown> {
    const res = await this.post(ep, method, params, signal);
    return this.result(await res.json().catch(() => undefined));
  }

  private async post(ep: A2aEndpoint, method: Method, params: object, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.headers(),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (ep.version !== '0.3') headers['a2a-version'] = ep.version; // 0.3 servers predate the header; none means 0.3
    const res = await fetch(ep.url, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: METHODS[ep.version][method], params }),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${clip(await res.text().catch(() => ''))}`.trim());
    return res;
  }

  /** The result of a JSON-RPC response; an error response throws. */
  private result(msg: unknown): unknown {
    if (!isObj(msg)) this.malformed();
    if (isObj(msg.error)) {
      const code = typeof msg.error.code === 'number' ? msg.error.code : 0;
      const text = typeof msg.error.message === 'string' ? msg.error.message : 'error';
      throw new RpcError(`${this.name}: ${clip(text)} (${code})`, code);
    }
    return msg.result;
  }

  private malformed(): never {
    throw new Error(`${this.name}: the answer is not an A2A response`);
  }

  private reply(tracker: Tracker): AgentReply {
    const contextId = tracker.contextId;
    if (tracker.message) return { text: render(tracker.message), agentSessionId: encodeSession({ contextId }) };
    const task = tracker.task!;
    const status = render(task.status);
    switch (task.state) {
      case 'completed': {
        const artifacts = [...task.artifacts.values()].map(render).filter(Boolean).join('\n\n');
        return { text: artifacts || status, agentSessionId: encodeSession({ contextId }) };
      }
      case 'input-required':
      case 'auth-required':
        return {
          text: status || (task.state === 'auth-required' ? `${this.name} needs authorization to go on.` : `${this.name} needs more input.`),
          agentSessionId: encodeSession({ contextId, taskId: task.id, open: 'input' }),
        };
      default:
        throw new Error(`${this.name}: the task ${task.state === 'canceled' ? 'was canceled' : task.state === 'rejected' ? 'was rejected' : 'failed'}${status ? `: ${clip(status)}` : ''}`);
    }
  }
}

/** Collects one turn's events into the task (or direct message) that answers it. */
class Tracker {
  contextId?: string;
  task?: TaskView;
  message?: Part[];
  private readonly onProgress?: (line: string) => void;
  private readonly onTask: (taskId: string, contextId: string | undefined) => void;

  constructor(contextId: string | undefined, onProgress: ((line: string) => void) | undefined, onTask: (taskId: string, contextId: string | undefined) => void) {
    this.contextId = contextId;
    this.onProgress = onProgress;
    this.onTask = onTask;
  }

  get done(): boolean {
    return this.message !== undefined || (this.task !== undefined && SETTLED.has(this.task.state));
  }

  apply(ev: Event) {
    if ('contextId' in ev && ev.contextId) this.contextId = ev.contextId;
    switch (ev.kind) {
      case 'message':
        // A message inside a task's stream is commentary; without a task it is the whole answer.
        if (this.task) this.progress(ev.parts);
        else this.message = ev.parts;
        return;
      case 'task': {
        const task = this.see(ev.task.id);
        task.state = ev.task.state;
        task.status = ev.task.status;
        if (ev.task.artifacts.size) task.artifacts = ev.task.artifacts;
        if (!SETTLED.has(task.state)) this.progress(task.status);
        return;
      }
      case 'status': {
        const task = this.see(ev.taskId);
        task.state = ev.state;
        task.status = ev.parts;
        if (!SETTLED.has(ev.state)) this.progress(ev.parts);
        return;
      }
      case 'artifact': {
        const artifacts = this.see(ev.taskId).artifacts;
        artifacts.set(ev.artifactId, ev.append ? [...(artifacts.get(ev.artifactId) ?? []), ...ev.parts] : ev.parts);
        return;
      }
    }
  }

  private see(id: string): TaskView {
    if (this.task?.id !== id) {
      this.task = { id, state: 'submitted', status: [], artifacts: new Map() };
      this.onTask(id, this.contextId);
    }
    return this.task;
  }

  private progress(parts: Part[]) {
    const line = parts.flatMap((p) => (p.text ? [p.text] : [])).join(' ').trim();
    if (line) this.onProgress?.(line);
  }
}

/** The card's URL: `url` itself when it names a .json file, else the well-known path under it. */
export function cardLocation(url: string): string {
  const u = new URL(url);
  if (!u.pathname.endsWith('.json')) u.pathname = `${u.pathname.replace(/\/+$/, '')}/.well-known/agent-card.json`;
  return u.href;
}

/** The card's JSON-RPC interface in the newest version both sides speak. */
function jsonRpcInterface(card: Record<string, unknown>): { url: string; version: Version } | undefined {
  const offers: { url: unknown; binding: unknown; version: unknown }[] = [];
  // 1.0 lists every interface with its own version.
  if (Array.isArray(card.supportedInterfaces)) {
    for (const i of card.supportedInterfaces) if (isObj(i)) offers.push({ url: i.url, binding: i.protocolBinding, version: i.protocolVersion });
  }
  // 0.3: the main url in its preferred transport, then additionalInterfaces, all in the card's version.
  if (typeof card.url === 'string') {
    const version = card.protocolVersion ?? '0.3';
    offers.push({ url: card.url, binding: card.preferredTransport ?? 'JSONRPC', version });
    if (Array.isArray(card.additionalInterfaces)) {
      for (const i of card.additionalInterfaces) if (isObj(i)) offers.push({ url: i.url, binding: i.transport, version });
    }
  }
  for (const version of VERSIONS) {
    const hit = offers.find((o) => typeof o.url === 'string' && o.binding === 'JSONRPC' && majorMinor(o.version) === version);
    if (hit) return { url: hit.url as string, version };
  }
  return undefined;
}

const majorMinor = (v: unknown) => (typeof v === 'string' ? v.split('.').slice(0, 2).join('.') : undefined);

function outgoing(version: Version, text: string, files: { name: string; mime?: string; data: string }[], ids: { contextId?: string; taskId?: string }) {
  const where = { ...(ids.contextId && { contextId: ids.contextId }), ...(ids.taskId && { taskId: ids.taskId }) };
  if (version === '1.0') {
    const parts = [{ text }, ...files.map((f) => ({ raw: f.data, filename: f.name, ...(f.mime && { mediaType: f.mime }) }))];
    return { messageId: randomUUID(), role: 'ROLE_USER', parts, ...where };
  }
  const parts = [{ kind: 'text', text }, ...files.map((f) => ({ kind: 'file', file: { bytes: f.data, name: f.name, ...(f.mime && { mimeType: f.mime }) } }))];
  return { kind: 'message', messageId: randomUUID(), role: 'user', parts, ...where };
}

/** One answer or stream event of either version: 1.0 wraps it in a field named after its type, 0.3 tags it with `kind`. */
function decodeEvent(r: unknown): Event | undefined {
  if (!isObj(r)) return undefined;
  if (isObj(r.task)) return taskEvent(r.task);
  if (isObj(r.message)) return messageEvent(r.message);
  if (isObj(r.statusUpdate)) return statusEvent(r.statusUpdate);
  if (isObj(r.artifactUpdate)) return artifactEvent(r.artifactUpdate);
  switch (r.kind) {
    case 'task':
      return taskEvent(r);
    case 'message':
      return messageEvent(r);
    case 'status-update':
      return statusEvent(r);
    case 'artifact-update':
      return artifactEvent(r);
    default:
      return undefined;
  }
}

function taskEvent(t: unknown): Event | undefined {
  if (!isObj(t) || typeof t.id !== 'string') return undefined;
  const status = isObj(t.status) ? t.status : {};
  const artifacts = new Map<string, Part[]>();
  if (Array.isArray(t.artifacts)) {
    t.artifacts.forEach((a, i) => isObj(a) && artifacts.set(typeof a.artifactId === 'string' ? a.artifactId : String(i), parts(a.parts)));
  }
  return { kind: 'task', contextId: str(t.contextId), task: { id: t.id, state: state(status.state), status: messageParts(status.message), artifacts } };
}

function messageEvent(m: Record<string, unknown>): Event {
  return { kind: 'message', contextId: str(m.contextId), parts: parts(m.parts) };
}

function statusEvent(e: Record<string, unknown>): Event | undefined {
  if (typeof e.taskId !== 'string') return undefined;
  const status = isObj(e.status) ? e.status : {};
  return { kind: 'status', contextId: str(e.contextId), taskId: e.taskId, state: state(status.state), parts: messageParts(status.message) };
}

function artifactEvent(e: Record<string, unknown>): Event | undefined {
  if (typeof e.taskId !== 'string' || !isObj(e.artifact)) return undefined;
  const id = typeof e.artifact.artifactId === 'string' ? e.artifact.artifactId : '';
  return { kind: 'artifact', taskId: e.taskId, artifactId: id, parts: parts(e.artifact.parts), append: e.append === true };
}

/** TASK_STATE_INPUT_REQUIRED (1.0) and input-required (0.3) are the same state. */
function state(s: unknown): State {
  const name = typeof s === 'string' ? s.toLowerCase().replace(/^task_state_/, '').replace(/_/g, '-') : '';
  return (STATES as readonly string[]).includes(name) ? (name as State) : 'unknown';
}

const messageParts = (m: unknown) => (isObj(m) ? parts(m.parts) : []);

function parts(v: unknown): Part[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p): Part[] => {
    if (!isObj(p)) return [];
    if (typeof p.text === 'string') return [{ text: p.text }];
    if ('data' in p) return [{ data: p.data }];
    const f = isObj(p.file) ? p.file : p; // 0.3 nests a file's fields under `file`
    const filename = str(f.name) ?? str(f.filename);
    const url = str(f.uri) ?? str(f.url);
    if (url) return [{ url, filename }];
    const raw = str(f.bytes) ?? str(f.raw);
    if (raw !== undefined) return [{ raw, filename }];
    return [];
  });
}

/** Parts as chat text. Files the agent returns are named, not downloaded. */
function render(ps: Part[]): string {
  return ps
    .map((p) => {
      if (p.text !== undefined) return p.text;
      if (p.url) return `${p.filename ?? 'file'}: ${p.url}`;
      if (p.raw !== undefined) return `[${p.filename ?? 'file'}: ${Buffer.from(p.raw, 'base64').length} bytes, not shown]`;
      return `\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\``;
    })
    .join('\n')
    .trim();
}

function parseSession(id: string | undefined): Session {
  if (!id) return {};
  try {
    const s = JSON.parse(id) as unknown;
    if (!isObj(s)) return {};
    const open = s.open === 'running' || s.open === 'input' ? s.open : undefined;
    return { contextId: str(s.contextId), taskId: str(s.taskId), open };
  } catch {
    return {}; // a session id from before this agent spoke A2A: start a new context
  }
}

function encodeSession(s: Session): string | undefined {
  const kept = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? JSON.stringify(kept) : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const clip = (s: string) => (s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS - 1)}…` : s);
