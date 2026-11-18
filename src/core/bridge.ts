import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { personIdOn, type BridgeConfig, type TrustLevel } from '../config/schema.ts';
import { remoteAgents, type AgentFactory } from '../adapters/agent/index.ts';
import type { AgentAdapter, AgentReply, Workspace } from '../adapters/agent/types.ts';
import type { Choice, ImAdapter, InboundAction } from '../adapters/im/types.ts';
import { randomUUID } from 'node:crypto';
import { McpHub, type HubBackend, type SessionGrant, type ToolResult } from '../mcp/hub.ts';
import { ToolHub } from '../mcp/tools.ts';
import { memoryStorage, OAuthFlows, watchTokens, type OAuthStorage } from '../mcp/oauth.ts';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { dmKey, isDmKey, localBaseUrl, parseDuration, sessionSlug } from './address.ts';
import { minTrust, newEnvelope, type ContentBlock, type Envelope } from './envelope.ts';
import { PolicyEngine } from './policy.ts';
import { Router, type InboundFile, type InboundMessage } from './router.ts';
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { BridgeStore } from './store.ts';
import { Redactor } from './redact.ts';
import { DEFAULT_TEMP_DIR, privateDir } from './temp.ts';
import { envSecrets, type SecretResolver } from './secrets.ts';

interface ThreadRef {
  platform: string;
  channelId: string;
  threadId: string;
  isDM: boolean;
}

/** One agent turn in progress: who is running, for which thread, under which envelope. */
interface TurnCtx {
  sessionKey: string;
  /** The IM-facing session that started the chain; costs roll up here. */
  rootKey: string;
  agent: string;
  envelope: Envelope;
  thread: ThreadRef;
  /** Aborted when the turn ends (or the bridge shuts down): stops the agent, cancels its pending questions. */
  controller: AbortController;
}

interface Job {
  sessionKey: string;
  agent: string;
  text: string;
  envelope: Envelope;
  thread: ThreadRef;
  /** How many times this turn was cut off by a bridge restart. */
  interrupted?: number;
}

/** A turn interrupted this many times is given up instead of resumed again. */
const MAX_RESUMES = 2;

interface Waiter {
  allowed: Set<string>;
  /** Does this text answer the waiter (whoever sent it)? */
  accepts(text: string): boolean;
  offer(personId: string, text: string): boolean;
  /** Give up waiting (the turn ended, the bridge is stopping). */
  cancel(reason: string): void;
}

export interface BridgeOptions {
  cfg: BridgeConfig;
  store: BridgeStore;
  ims: ImAdapter[];
  /** Resolves `secret:` / `env:` references in the config (default: the environment only). */
  secrets?: SecretResolver;
  /**
   * Keeps credentials out of the audit trail. Pass one to add values resolved outside the bridge (the IM
   * tokens the app built its adapters with); every secret the bridge resolves itself is added too.
   */
  redactor?: Redactor;
  /**
   * Builds agents from cfg.agents (default: remote ones only). Pass `localAgents` from the `/local` entry point
   * to run claude-code and stdio agents on this machine.
   */
  agentFactory?: AgentFactory;
  /** Pre-built agents (tests, or agents the app implements itself); the rest are built from cfg.agents. */
  agents?: Map<string, AgentAdapter>;
  tools?: ToolHub;
  /** OAuth tokens for tool servers (default: in memory, so sign-ins last until the process ends). */
  oauthStorage?: OAuthStorage;
  /**
   * Where agents reach this bridge's MCP endpoints and the OAuth callback, when the app serves `handle` on its
   * own HTTP server (e.g. "https://app.example.com/bridge/u123"). Without it the bridge listens on
   * cfg.server.host:port itself.
   */
  mcpBaseUrl?: string;
  /**
   * More routes on the server the bridge listens on itself (no mcpBaseUrl), such as a dashboard built on
   * `sessions`, `pendingChoices` and the other methods for the app. Return false to answer 404.
   */
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /**
   * Where the bridge keeps temporary files, readable by this user only: attachments under `files/` (deleted after
   * `files_ttl`) and agents' scratch files (default: `bridge` in the OS temp folder).
   */
  tempDir?: string;
  /** Where log lines go (default: the console); `error` marks failures someone should look at. */
  log?: (line: string, level: 'info' | 'error') => void;
}

/** A conversation, for the app (see `Bridge.sessions`). */
export interface SessionInfo {
  key: string;
  agent: string;
  platform: string;
  initiator: string;
  createdAt: number;
  lastActive: number;
  spentUsd: number;
  /** A turn is running or queued. */
  busy: boolean;
  /** The branch's status (name, unmerged commits, diffstat), when the agent keeps one and it exists. */
  branch?: string;
  /** The branch has commits that can be squash-merged now. */
  canMerge?: boolean;
}

/** One audit trail entry; `detail` is redacted JSON. */
export interface AuditEntry {
  ts: number;
  session: string;
  kind: string;
  actor: string;
  detail: string;
}

/** An approval or confirmation waiting for one of `allowed`. */
export interface PendingChoice {
  id: string;
  /** The conversation it was asked in. */
  key: string;
  text: string;
  choices: { label: string; value: string; style?: string }[];
  allowed: string[];
  createdAt: number;
}

/** A tool server and whether it answers. */
export interface ToolServerInfo {
  name: string;
  kind: 'stdio' | 'http';
  /** Its URL, or its command line. */
  target: string;
  oauth: 'signed-in' | 'signed-out' | 'not-oauth';
  /** How many tools it offers, when it answered. */
  tools?: number;
  error?: string;
}

const APPROVE = /^(approve|approved|yes|y|ok|lgtm|批准|同意|可以|确认|好|好的|是)$/i;

/** A message that is exactly one of these words is a workspace command, not a prompt. */
const COMMANDS = new Map<string, 'status' | 'merge' | 'discard' | 'pr'>([
  ['status', 'status'], ['状态', 'status'],
  ['merge', 'merge'], ['合并', 'merge'],
  ['pr', 'pr'], ['开pr', 'pr'],
  ['discard', 'discard'], ['丢弃', 'discard'], ['放弃', 'discard'],
]);

/** ask_human waits between 1 minute and 1 day, whatever the agent asks for. */
const ASK_MINUTES = { default: 30, min: 1, max: 24 * 60 };

/** How long `sessions` reuses a conversation's branch status (git is slow); turn ends and merges refresh it. */
const BRANCH_CACHE_MS = 30e3;
/** `sessions` looks up branches for at most this many of the most recent conversations. */
const BRANCH_LOOKUPS = 30;
/** How long `toolServers` waits for each server's tool list. */
const TOOL_STATUS_MS = 10e3;
/** Housekeeping runs this often, and first this long after start. */
const HOUSEKEEPING_MS = 6 * 3600e3;
const FIRST_HOUSEKEEPING_MS = 60e3;
/** At most one progress edit of a turn's placeholder message per this interval (IM rate limits). */
const PROGRESS_EDIT_MS = 1500;
/** How long a merge / discard / pr confirmation in the chat waits. */
const CONFIRM_MS = 10 * 60e3;
const DENY = /^(deny|denied|no|n|reject|拒绝|不行)$/i;

export class Bridge implements HubBackend {
  private cfg: BridgeConfig;
  private router: Router;
  private policies: PolicyEngine;
  private readonly store: BridgeStore;
  private readonly ims = new Map<string, ImAdapter>();
  private readonly agents = new Map<string, AgentAdapter>();
  private readonly injectedAgents: Set<string>;
  private readonly tools: ToolHub;
  private readonly hub: McpHub;
  private readonly logLine: (line: string, level: 'info' | 'error') => void;
  private readonly chains = new Map<string, Promise<void>>();
  /** Inbound messages still being handled before they reach a chain. */
  private readonly inflight = new Set<Promise<unknown>>();
  /**
   * Turns in progress, by the MCP grant they were given (the hub hands back the same grant object), so two
   * turns on one session key never see each other's context.
   */
  private readonly active = new Map<SessionGrant, TurnCtx>();
  /** Turns in progress per adapter: a reloaded agent's old adapter is stopped only once this drops to 0. */
  private readonly running = new Map<AgentAdapter, number>();
  /** Adapters replaced by a config reload, waiting for their running turns to finish. */
  private readonly retiring = new Set<AgentAdapter>();
  /** Delegation session keys with a task in progress (one at a time each). */
  private readonly delegating = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** Open button choices by id: who may click, and how to settle them. */
  private readonly choices = new Map<
    string,
    {
      allowed: Set<string>;
      settle: (r: { by: string; value: string }) => void;
      key: string;
      text: string;
      options: Choice[];
      at: number;
      /** Listed by `pendingChoices` (questions from `askInDms` are not). */
      listed: boolean;
    }
  >();
  private readonly redactor: Redactor;
  private readonly secrets: SecretResolver;
  private readonly agentFactory: AgentFactory;
  private readonly mcpBaseUrl?: string;
  /** Path prefix of mcpBaseUrl, stripped from requests before routing. */
  private readonly mountPath: string;
  private readonly extraRoutes?: BridgeOptions['extraRoutes'];
  private http?: HttpServer;
  /** Set once the bridge listens itself (the real port when cfg.server.port is 0). */
  private listenUrl?: string;
  /** Writes nobody waits for (the audit trail, a session id reported mid-turn), applied in order. */
  private writes: Promise<void> = Promise.resolve();
  /** Dashboard branch status per session key (see BRANCH_CACHE_MS). */
  private readonly branchCache = new Map<string, { at: number; branch?: string; canMerge: boolean }>();
  readonly oauth: OAuthFlows;
  private startedAt = 0;
  private readonly tempDir: string;
  /** Attachments, by conversation. */
  private readonly filesDir: string;
  private housekeeping?: NodeJS.Timeout;
  private firstCleanUp?: NodeJS.Timeout;
  /** Set by stop(): no new turns start, and interrupted ones stay queued to resume on the next start. */
  private stopping = false;
  /** Queued work waits for this, so nothing runs before the IMs are connected. */
  private readonly ready = Promise.withResolvers<void>();

  constructor(opts: BridgeOptions) {
    this.cfg = opts.cfg;
    this.redactor = opts.redactor ?? new Redactor();
    const resolve = opts.secrets ?? envSecrets();
    // Every credential the bridge resolves is kept out of its audit trail.
    this.secrets = (ref) => {
      const value = resolve(ref);
      if (value !== ref) this.redactor.add(value);
      return value;
    };
    this.agentFactory = opts.agentFactory ?? remoteAgents;
    this.mcpBaseUrl = opts.mcpBaseUrl?.replace(/\/+$/, '');
    this.mountPath = this.mcpBaseUrl ? new URL(this.mcpBaseUrl).pathname.replace(/\/+$/, '') : '';
    this.extraRoutes = opts.extraRoutes;
    this.router = new Router(opts.cfg);
    this.policies = new PolicyEngine(opts.cfg);
    this.store = opts.store;
    for (const im of opts.ims) this.ims.set(im.platform, im);
    for (const [k, v] of opts.agents ?? []) this.agents.set(k, v);
    this.injectedAgents = new Set(opts.agents?.keys() ?? []);
    const oauthStorage = watchTokens(opts.oauthStorage ?? memoryStorage(), (t) => this.redactor.add(t));
    const redirectUrl = `${this.baseUrl()}/oauth/callback`;
    this.tools = opts.tools ?? new ToolHub(opts.cfg.tools, { secrets: this.secrets, oauth: { storage: oauthStorage, redirectUrl } });
    this.oauth = new OAuthFlows(() => this.cfg.tools, oauthStorage, redirectUrl, this.secrets, (server) => {
      this.trace('-', 'oauth', 'web', { server, signedIn: this.oauth.status(server) === 'signed-in' });
      this.tools.reset(server).catch((err) => this.warn(`tool server ${server} not reset: ${(err as Error).message}`));
    });
    this.hub = new McpHub(this, () => this.baseUrl());
    this.logLine = opts.log ?? ((l, level) => (level === 'error' ? console.error(l) : console.log(l)));
    this.tempDir = opts.tempDir ?? DEFAULT_TEMP_DIR;
    this.filesDir = join(this.tempDir, 'files');
  }

  /**
   * Connect the IMs and start routing. Without mcpBaseUrl the bridge also starts its own HTTP server on
   * cfg.server; with it, the app serves `handle` and nothing listens here. Returns where agents reach the bridge.
   */
  async start(): Promise<{ mcpUrl: string }> {
    privateDir(this.tempDir);
    if (!this.mcpBaseUrl) await this.listen();
    const mcpUrl = this.baseUrl();
    // Work left over from the last run takes its place in the queues before any new message can;
    // it runs once the IMs are connected (see `ready`).
    await this.replayQueue();
    for (const im of this.ims.values()) {
      await im.start(
        (msg) => this.track(this.handleInbound(msg).catch((e) => this.warn(`inbound error: ${e?.stack ?? e}`))),
        (action) => this.track(this.handleAction(action).catch((e) => this.warn(`action error: ${e?.stack ?? e}`))),
      );
      this.log(`connected ${im.platform}`);
    }
    this.startedAt = Date.now();
    this.ready.resolve();
    this.housekeeping = setInterval(() => void this.cleanUp(), HOUSEKEEPING_MS);
    this.housekeeping.unref();
    this.firstCleanUp = setTimeout(() => void this.cleanUp(), FIRST_HOUSEKEEPING_MS);
    this.firstCleanUp.unref();
    return { mcpUrl };
  }

  /**
   * Shut down. Running turns are ended (their agents stopped, pending questions cancelled) but stay in the
   * queue, so the next start resumes them; queued ones that never started run then too.
   */
  async stop() {
    this.stopping = true;
    clearInterval(this.housekeeping);
    clearTimeout(this.firstCleanUp);
    this.ready.resolve();
    for (const ctx of this.active.values()) ctx.controller.abort();
    for (const list of [...this.waiters.values()]) for (const w of [...list]) w.cancel('the bridge is shutting down');
    for (const a of new Set([...this.agents.values(), ...this.retiring])) {
      await a.stop?.().catch((err) => this.warn(`stopping agent ${a.name} failed: ${(err as Error).message}`));
    }
    await this.idle();
    for (const im of this.ims.values()) await im.stop().catch((err) => this.warn(`disconnecting ${im.platform} failed: ${(err as Error).message}`));
    await this.tools.stop();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    await this.flushWrites();
  }

  /**
   * Apply a new bridge.yaml without dropping IM connections. IM credential changes need a restart.
   * Agents whose config changed (or that were removed) get a new adapter for their next turn; the old one is
   * stopped only after its running turns have finished.
   */
  reload(cfg: BridgeConfig) {
    const old = this.cfg;
    this.cfg = cfg;
    this.router = new Router(cfg);
    this.policies = new PolicyEngine(cfg);
    for (const [name, agent] of this.agents) {
      if (this.injectedAgents.has(name)) continue;
      const before = Object.hasOwn(old.agents, name) ? old.agents[name] : undefined;
      const after = Object.hasOwn(cfg.agents, name) ? cfg.agents[name] : undefined;
      if (after && isDeepStrictEqual(before, after)) continue;
      this.agents.delete(name);
      this.retire(agent);
    }
    this.branchCache.clear();
    this.tools.update(cfg.tools).catch((err) => this.warn(`tool servers not updated: ${(err as Error).message}`));
    this.log('config reloaded');
  }

  private retire(adapter: AgentAdapter) {
    if (this.running.get(adapter)) {
      this.retiring.add(adapter);
      return;
    }
    this.retiring.delete(adapter);
    adapter.stop?.().catch((err) => this.warn(`stopping replaced agent ${adapter.name} failed: ${(err as Error).message}`));
  }

  /** Wait until every queued turn has finished (tests, graceful shutdown). */
  async idle() {
    while (this.chains.size || this.inflight.size) {
      await Promise.allSettled([...this.inflight, ...this.chains.values()]);
    }
    await this.flushWrites();
  }

  private track(p: Promise<unknown>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // ───────────────────────── inbound ─────────────────────────

  async handleInbound(msg: InboundMessage) {
    const person = this.person(msg.platform, msg.userId);
    const thread: ThreadRef = { platform: msg.platform, channelId: msg.channelId, threadId: msg.threadId, isDM: msg.isDM };
    const key = msg.isDM ? dmKey(msg.platform, msg.userId) : `${msg.platform}:${msg.channelId}:${msg.threadId}`;

    // Someone not in `people` is known by their platform id, the same id their turns use as initiator.
    const senderId = person?.id ?? `${msg.platform}:${msg.userId}`;
    // A reply someone is waiting for (ask_human / approval) never starts a new turn.
    const waited = this.offerToWaiters(key, senderId, msg.text);
    if (waited === 'consumed') return;
    if (waited) {
      await this.send(thread, `Only ${waited.join(', ')} can answer that.`);
      return;
    }

    let session = await this.store.getSession(key);
    if (session && msg.isDM && Date.now() - session.last_active > parseDuration(this.cfg.defaults.dm_idle_reset)) {
      await this.store.deleteSession(key);
      session = undefined;
    }

    const match = this.router.matchInbound(msg, { personId: person?.id, threadAgent: session?.agent });
    if (!match) {
      this.trace(key, 'ignored', senderId, { text: msg.text });
      if (!person && (msg.isDM || msg.mentioned)) {
        this.log(`ignored ${msg.platform} user ${msg.userId} — not in people: (add  ${msg.platform}: ${msg.userId}  to a person)`);
      }
      return;
    }

    if (/^\/?(reset|new)$/i.test(match.text.trim())) {
      await this.store.deleteSession(key);
      await this.send(thread, `🔄 Started a fresh ${match.agent} session.`);
      return;
    }

    const command = COMMANDS.get(match.text.trim().toLowerCase());
    const workspace = command ? this.agent(match.agent).workspace : undefined;
    if (command && workspace) {
      this.trace(key, 'command', senderId, { command });
      this.schedule(key, () => this.runCommand(command, workspace, key, thread, senderId));
      return;
    }

    const trust: TrustLevel = person?.trust ?? 'external';
    const budgetUsd = this.policies.budgetUsd(match.agent);
    this.trace(key, 'inbound', senderId, { route: match.index, agent: match.agent, text: match.text });
    // The message takes its place in the thread's queue now; attachments download when its turn comes, so a
    // big file never lets a later message overtake it.
    this.schedule(key, async () => {
      const envelope = newEnvelope({
        sender: { kind: 'person', id: senderId, platform: msg.platform, platformUserId: msg.userId, displayName: msg.userName },
        sessionKey: key,
        content: [{ type: 'text', text: match.text }, ...(await this.download(key, thread, msg.files ?? []))],
        trust,
        initiator: senderId,
        hops: 0,
        budgetUsd,
        tainted: trust === 'external',
      });
      const job: Job = { sessionKey: key, agent: match.agent, text: match.text, envelope, thread };
      await this.store.enqueue(envelope.id, key, job);
      await this.runJob(job);
    });
  }

  /** status / merge / discard on the conversation's branch. Runs in the thread's queue, so never mid-turn. */
  private async runCommand(command: 'status' | 'merge' | 'discard' | 'pr', ws: Workspace, key: string, thread: ThreadRef, who: string) {
    if (this.stopping) return void (await this.notify(thread, `⚠️ The bridge is shutting down — send \`${command}\` again once it is back.`));
    const confirm = async (prompt: string, action: Choice) => {
      const answer = await this.choose({
        key,
        thread,
        text: prompt,
        choices: [action, { label: 'Cancel', value: 'cancel' }],
        allowed: [who],
        timeoutMs: CONFIRM_MS,
        typedHint: 'Reply `yes` to go ahead; anything else cancels.',
        typed: (t) => (APPROVE.test(t) ? action.value : 'cancel'),
        outcome: (r) => (!r ? '⌛ No answer in 10 minutes — cancelled.' : r.value === 'cancel' ? `Cancelled by ${r.by}.` : `${action.label} — confirmed by ${r.by}.`),
      });
      return answer?.value === action.value;
    };
    try {
      if (command === 'status') {
        const status = await ws.status(key);
        const hint = `Reply \`merge\` to squash it into the base branch${ws.pr ? ', `pr` to open a pull request,' : ''} or \`discard\` to throw it away.`;
        await this.send(thread, status ? `${status}\n${hint}` : 'This conversation has no branch yet — it gets one with the first change.');
      } else if (command === 'pr') {
        if (!ws.previewPr || !ws.pr) {
          return void (await this.send(thread, '⚠️ No git token is configured for this agent — add `git_token` to it in bridge.yaml.'));
        }
        const preview = await ws.previewPr(key);
        if (!preview.ok) return void (await this.send(thread, `⚠️ ${preview.reason}`));
        if (!(await confirm(preview.summary, { label: 'Open PR', value: 'pr', style: 'primary' }))) return;
        const result = await ws.pr(key);
        this.trace(key, 'pr', who, { result });
        await this.send(thread, result);
      } else if (command === 'merge') {
        const preview = await ws.previewMerge(key);
        if (!preview.ok) return void (await this.send(thread, `⚠️ ${preview.reason}`));
        if (!(await confirm(preview.summary, { label: 'Merge', value: 'merge', style: 'primary' }))) return;
        const result = await ws.merge(key);
        await this.store.deleteSession(key);
        this.trace(key, 'merged', who, { result });
        await this.send(thread, result);
      } else {
        const lost = await ws.previewDiscard(key);
        if (lost === undefined) return void (await this.send(thread, 'This conversation has no branch to discard.'));
        if (lost && !(await confirm(`🗑 This throws away ${lost}`, { label: 'Discard', value: 'discard', style: 'danger' }))) return;
        const result = await ws.discard(key);
        await this.store.deleteSession(key);
        this.trace(key, 'discarded', who, {});
        await this.send(thread, result);
      }
    } catch (err) {
      await this.notify(thread, `⚠️ ${command} failed: ${(err as Error).message}`);
    } finally {
      this.branchCache.delete(key);
    }
  }

  /**
   * Queue work behind everything else for this conversation. The chain never rejects: a failing step is
   * logged and the next one still runs.
   */
  private schedule(key: string, fn: () => Promise<void>) {
    const prev = this.chains.get(key) ?? this.ready.promise;
    const next = prev
      .then(fn)
      .catch((err) => this.warn(`error in ${key}: ${(err as Error)?.stack ?? err}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async replayQueue() {
    const ttl = parseDuration(this.cfg.defaults.offline_queue_ttl);
    for (const row of await this.store.takePending(ttl)) {
      const job = JSON.parse(row.payload) as Job;
      if (row.status === 'pending') {
        this.log(`running queued message ${row.id} for ${job.agent}`);
        this.schedule(job.sessionKey, () => this.runJob(job));
        continue;
      }
      const interrupted = (job.interrupted ?? 0) + 1;
      const resumed: Job = { ...job, interrupted };
      // Count this interruption before anything else can fail, so a turn that crashes the bridge on resume
      // is still given up after MAX_RESUMES.
      await this.store.markRunning(row.id, resumed);
      this.log(`resuming interrupted turn ${row.id} for ${job.agent} (attempt ${interrupted})`);
      this.schedule(job.sessionKey, async () => {
        if (interrupted > MAX_RESUMES) {
          await this.store.finish(row.id, 'failed');
          await this.notify(job.thread, `⚠️ ${job.agent}'s turn was interrupted ${interrupted} times by bridge restarts, so I stopped retrying. Send the request again to restart it.`);
          return;
        }
        if (this.stopping) return; // still queued as running: resumes on the next start
        await this.notify(job.thread, `🔁 The bridge restarted in the middle of ${job.agent}'s turn — resuming.`);
        await this.runJob(resumed);
      });
    }
  }

  private async runJob(job: Job) {
    const { sessionKey, agent, thread } = job;
    // Shutting down: leave it queued (pending or running), the next start picks it up.
    if (this.stopping) return;
    await this.store.markRunning(job.envelope.id, job);
    const previous = await this.store.getSession(sessionKey);
    // Another agent's session id means nothing to this one: it starts fresh.
    const session = await this.store.upsertSession({
      key: sessionKey,
      agent,
      agent_session_id: previous?.agent === agent ? previous.agent_session_id : null,
      platform: thread.platform,
      channel_id: thread.channelId,
      thread_id: thread.threadId,
      initiator: job.envelope.initiator,
    });

    const progress = this.cfg.defaults.progress;
    const im = this.ims.get(thread.platform);
    const edit = im?.edit?.bind(im);
    let placeholder: string | undefined;
    // collapsed: the placeholder shows the latest step. verbose: it lists the last steps.
    let lastEdit = 0;
    let pending: NodeJS.Timeout | undefined;
    // Once the turn is over no progress edit may start, and the last one finishes before the reply is posted,
    // so a late edit can never overwrite the reply. Edits run one after another, in order.
    let finished = false;
    let edits = Promise.resolve();
    let editFailed = false;
    const steps: string[] = [];
    const render = () =>
      progress === 'verbose'
        ? `⏳ ${agent} is working (${steps.length} steps)\n${steps.slice(-8).map((s) => `• ${s}`).join('\n')}`
        : `⏳ ${agent}: ${steps.at(-1)}`;
    const flush = () => {
      pending = undefined;
      if (finished || !placeholder || !edit) return;
      lastEdit = Date.now();
      const [id, text] = [placeholder, render()];
      edits = edits.then(() => edit(thread.channelId, id, text)).catch((err) => {
        // The reply still replaces the placeholder (or is posted fresh) when the turn ends.
        if (!editFailed) this.warn(`progress edit in ${sessionKey} failed: ${(err as Error).message}`);
        editFailed = true;
      });
    };
    const onProgress = (line: string) => {
      if (finished) return;
      this.trace(sessionKey, 'progress', agent, { line });
      steps.push(line);
      if (!placeholder || !edit || pending) return;
      const wait = PROGRESS_EDIT_MS - (Date.now() - lastEdit);
      if (wait <= 0) flush();
      else pending = setTimeout(flush, wait); // last step still shows even when steps arrive fast
    };

    let outcome: { ok: true; text: string } | { ok: false; message: string };
    try {
      if (progress !== 'off' && im) {
        // Without a placeholder the turn still runs; the reply is posted fresh.
        placeholder = await this.send(thread, `⏳ ${agent} is working…`).catch((err) => {
          this.warn(`progress message to ${sessionKey} not delivered: ${(err as Error).message}`);
          return undefined;
        });
      }
      // Resuming a cut-off turn: the agent session already holds the request and any partial work.
      const text =
        job.interrupted && session.agent_session_id
          ? `[bridge] Your previous turn was interrupted because the bridge restarted. Check what you had already done, then finish the original request:\n\n${job.text}`
          : job.text;
      const ctx = { sessionKey, rootKey: sessionKey, agent, envelope: job.envelope, thread };
      const reply = await this.invoke(ctx, text, session.agent_session_id ?? undefined, { onProgress });
      outcome = { ok: true, text: reply.text || '(no reply)' };
    } catch (err) {
      // A refused turn is an answer, not a failure: it is already in the audit trail as `budget`.
      outcome = err instanceof BudgetRefusal ? { ok: true, text: `💸 ${err.message}` } : { ok: false, message: (err as Error)?.message ?? String(err) };
    } finally {
      finished = true;
      clearTimeout(pending);
      await edits;
    }

    if (outcome.ok) {
      await this.post(thread, outcome.text, placeholder).catch((err) => this.warn(`reply to ${sessionKey} not delivered: ${(err as Error).message}`));
      await this.store.finish(job.envelope.id, 'done');
    } else if (this.stopping) {
      // Cut off by shutdown: the queue row stays `running`, so the next start resumes the turn.
      this.trace(sessionKey, 'interrupted', agent, { message: outcome.message });
      await this.post(thread, `⏸ ${agent}'s turn was interrupted by a bridge shutdown — it resumes when the bridge is back.`, placeholder).catch((err) =>
        this.warn(`interruption notice to ${sessionKey} not delivered: ${(err as Error).message}`),
      );
    } else {
      this.trace(sessionKey, 'error', agent, { message: outcome.message });
      await this.post(thread, `⚠️ ${agent} failed: ${outcome.message}`, placeholder).catch((err) => this.warn(`error report to ${sessionKey} not delivered: ${(err as Error).message}`));
      await this.store.finish(job.envelope.id, 'failed');
    }
  }

  /** Run one agent turn with a session-scoped MCP grant. */
  private async invoke(
    turn: Omit<TurnCtx, 'controller'>,
    text: string,
    agentSessionId: string | undefined,
    opts: { onProgress?: (l: string) => void; /** A delegated turn ends with the turn that delegated it. */ parent?: AbortSignal } = {},
  ): Promise<AgentReply> {
    const adapter = this.agent(turn.agent);
    const ctx: TurnCtx = { ...turn, controller: new AbortController() };
    const budgetUsd = await this.remainingBudget(ctx);
    const refusal = await this.budgetRefusal(ctx, budgetUsd);
    if (refusal) {
      this.trace(ctx.sessionKey, 'budget', ctx.agent, refusal.detail);
      throw refusal;
    }
    if (opts.parent?.aborted) throw new Error('the delegating turn has ended');
    const endWithParent = () => ctx.controller.abort();
    opts.parent?.addEventListener('abort', endWithParent, { once: true });
    const sessionGrant: SessionGrant = { sessionKey: ctx.sessionKey, agent: ctx.agent };
    const grant = this.hub.grant(sessionGrant);
    this.active.set(sessionGrant, ctx);
    this.running.set(adapter, (this.running.get(adapter) ?? 0) + 1);
    try {
      const reply = await adapter.run({
        signal: ctx.controller.signal,
        envelope: ctx.envelope,
        text,
        agentSessionId,
        budgetUsd,
        files: ctx.envelope.content.flatMap((b) =>
          b.type === 'file' && b.path ? [{ name: b.name, path: b.path, mime: b.mime }] : [],
        ),
        mcp: { url: grant.url, endpoint: grant.endpoint, token: grant.token },
        onProgress: opts.onProgress,
        onSessionId: (id) => this.later(() => this.store.updateSession(ctx.sessionKey, { agent_session_id: id })),
        onNotice: (note) => void this.notify(ctx.thread, note),
      });
      await this.store.updateSession(ctx.sessionKey, { agent_session_id: reply.agentSessionId ?? null });
      if (reply.costUsd) await this.store.updateSession(ctx.rootKey, { addSpentUsd: reply.costUsd });
      this.trace(ctx.sessionKey, 'reply', ctx.agent, { text: reply.text, costUsd: reply.costUsd });
      return reply;
    } finally {
      grant.revoke();
      opts.parent?.removeEventListener('abort', endWithParent);
      this.active.delete(sessionGrant);
      // The turn is over: anything it still waits for (approvals, ask_human) is cancelled.
      ctx.controller.abort();
      const left = (this.running.get(adapter) ?? 1) - 1;
      if (left) this.running.set(adapter, left);
      else {
        this.running.delete(adapter);
        if (this.retiring.has(adapter)) this.retire(adapter);
      }
      this.branchCache.delete(ctx.rootKey);
    }
  }

  /** Save a message's attachments under filesDir/<conversation>/; oversize or failed ones are reported, not fatal. */
  private async download(key: string, thread: ThreadRef, files: InboundFile[]): Promise<ContentBlock[]> {
    if (!files.length) return [];
    const max = this.cfg.defaults.max_file_mb * 1024 * 1024;
    const dir = join(this.filesDir, sessionSlug(key));
    const out: ContentBlock[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      if (f.size !== undefined && f.size > max) {
        skipped.push(`${f.name} (over ${this.cfg.defaults.max_file_mb} MB)`);
        continue;
      }
      try {
        const data = await f.download();
        if (data.length > max) throw new Error(`over ${this.cfg.defaults.max_file_mb} MB`);
        const path = join(dir, `${Date.now()}-${f.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(-120)}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, data);
        out.push({ type: 'file', name: f.name, mime: f.mime, path });
      } catch (err) {
        skipped.push(`${f.name} (${(err as Error).message})`);
      }
    }
    if (skipped.length) await this.notify(thread, `⚠️ Couldn't pass along: ${skipped.join(', ')}`);
    return out;
  }

  /**
   * Periodic housekeeping: expire downloaded files, prune idle conversation worktrees, and drop old queue rows,
   * trace entries and sessions. Never throws: every step is logged and the rest still runs.
   */
  async cleanUp() {
    const step = async (what: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        this.warn(`housekeeping: ${what} failed: ${(err as Error)?.message ?? err}`);
      }
    };
    const { defaults } = this.cfg;
    await step('expiring attachments', () => this.expireFiles(parseDuration(defaults.files_ttl)));
    if (defaults.worktree_prune_after !== 'off') {
      const since = Date.now() - parseDuration(defaults.worktree_prune_after);
      const recent = new Set((await this.store.sessionsActiveSince(since)).map(sessionSlug));
      const isIdle = (slug: string) => !recent.has(slug);
      for (const name of Object.keys(this.cfg.agents)) {
        await step(`worktree prune for ${name}`, async () => {
          const ws = this.agent(name).workspace;
          if (!ws) return;
          const { removed, errors } = await ws.prune(isIdle);
          for (const b of removed) this.log(`pruned idle worktree ${b}`);
          for (const e of errors) this.warn(`housekeeping: worktree prune for ${name}: ${e}`);
        });
      }
    }
    await step('pruning history', async () => {
      const now = Date.now();
      const removed = await this.store.prune({
        queueBefore: now - parseDuration(defaults.offline_queue_ttl),
        historyBefore: defaults.retention === 'off' ? undefined : now - parseDuration(defaults.retention),
      });
      if (removed.trace || removed.sessions) this.log(`housekeeping: removed ${removed.trace} trace entries, ${removed.sessions} idle sessions`);
    });
  }

  /** Delete attachments older than `ttlMs`, and conversation folders left empty. Stray files are skipped. */
  private expireFiles(ttlMs: number) {
    if (!existsSync(this.filesDir)) return;
    for (const conv of readdirSync(this.filesDir, { withFileTypes: true })) {
      if (!conv.isDirectory()) continue;
      const dir = join(this.filesDir, conv.name);
      try {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          try {
            if (Date.now() - statSync(p).mtimeMs > ttlMs) rmSync(p, { recursive: true, force: true });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // removed meanwhile: fine
          }
        }
        // rmdir (not rm -r) refuses a folder a new download just wrote into.
        if (!readdirSync(dir).length) rmdirSync(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT') this.warn(`housekeeping: ${dir}: ${(err as Error).message}`);
      }
    }
  }

  /** What's left of the conversation budget (shared by every agent in a delegation chain). */
  private async remainingBudget(ctx: TurnCtx): Promise<number | undefined> {
    if (ctx.envelope.budgetUsd === undefined) return undefined;
    const spent = (await this.store.getSession(ctx.rootKey))?.spent_usd ?? 0;
    return Math.max(0, ctx.envelope.budgetUsd - spent);
  }

  /**
   * Whether a turn may start with what is left of the conversation budget. An agent's spending cap is only
   * checked between model requests, so a turn started with less than one request costs overshoots the budget;
   * a turn starts only when at least the agent's cheapest recent turn is left.
   */
  private async budgetRefusal(ctx: TurnCtx, left: number | undefined): Promise<BudgetRefusal | undefined> {
    const budget = ctx.envelope.budgetUsd;
    if (budget === undefined || left === undefined) return undefined;
    const reset = 'Send "reset" to start a new conversation with a fresh budget.';
    if (left <= 0) {
      return new BudgetRefusal(`${ctx.agent} has used the $${budget} budget of this conversation. ${reset}`, {
        budgetUsd: budget,
        leftUsd: 0,
      });
    }
    await this.flushWrites(); // the replies of earlier turns are in the audit trail
    const floor = await this.store.cheapestRecentTurn(ctx.agent);
    if (floor !== undefined && left < floor) {
      return new BudgetRefusal(
        `${ctx.agent} needs more than the $${left.toFixed(2)} left of this conversation's $${budget} budget (its cheapest recent turn cost $${floor.toFixed(2)}). ${reset}`,
        { budgetUsd: budget, leftUsd: left, cheapestTurnUsd: floor },
      );
    }
    return undefined;
  }

  // ───────────────────────── state writes ─────────────────────────

  /** Append to the audit trail, cleared of every credential this bridge resolved. Not awaited; kept in order. */
  private trace(sessionKey: string, kind: string, actor: string, detail: unknown) {
    const json = this.redactor.redact(JSON.stringify(detail ?? null));
    this.later(() => this.store.trace(sessionKey, kind, actor, json));
  }

  /** Queue a write nobody waits for; writes run one after another, in the order they were queued. */
  private later(write: () => unknown) {
    this.writes = this.writes.then(write).then(
      () => undefined,
      (err) => this.warn(`state write failed: ${(err as Error)?.message ?? err}`),
    );
  }

  /** Wait until every queued write has landed (before reading what they wrote). */
  private flushWrites(): Promise<void> {
    return this.writes;
  }

  /** The URL agents and OAuth providers reach this bridge at. */
  private baseUrl(): string {
    return this.mcpBaseUrl ?? this.listenUrl ?? localBaseUrl(this.cfg.server);
  }

  // ───────────────────────── HTTP ─────────────────────────

  /**
   * Serve the bridge's routes: each turn's MCP endpoint (`/mcp/<token>`) and the OAuth callback
   * (`/oauth/callback`), relative to mcpBaseUrl. Resolves false for any other path, so an app can mount it in
   * front of its own routes. Sign-ins start with `bridge.oauth.start(server)`, behind the app's own auth.
   */
  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (this.mountPath && url.pathname !== this.mountPath && !url.pathname.startsWith(`${this.mountPath}/`)) return false;
    const path = url.pathname.slice(this.mountPath.length) || '/';
    if (await this.hub.handle(req, res, path)) return true;
    if (path === '/oauth/callback') return this.oauth.handle(req, res, new URL(path + url.search, url));
    return false;
  };

  private async listen() {
    const { host, port } = this.cfg.server;
    this.http = createServer((req, res) => {
      const route = async () => {
        if (await this.handle(req, res)) return;
        const url = new URL(req.url ?? '/', 'http://x');
        if (this.extraRoutes && (await this.extraRoutes(req, res, url))) return;
        res.writeHead(404).end();
      };
      route().catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => resolve());
    });
    const addr = this.http.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    this.listenUrl = localBaseUrl({ host, port: actual });
  }

  // ───────────────────────── MCP backend ─────────────────────────

  async listTools(grant: SessionGrant): Promise<Tool[]> {
    const ctx = this.active.get(grant);
    if (!ctx || ctx.controller.signal.aborted) return [];
    const tools: Tool[] = [
      {
        name: 'send_message',
        description: 'Post an interim message to the conversation you are answering (only that thread).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'ask_human',
        description: `Ask ${ctx.envelope.initiator} a question in the conversation and wait for their reply.`,
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            timeout_minutes: {
              type: 'number',
              description: `How long to wait, in minutes (default ${ASK_MINUTES.default}, ${ASK_MINUTES.min}–${ASK_MINUTES.max}).`,
            },
          },
          required: ['question'],
        },
      },
    ];
    const peers = Object.keys(this.cfg.agents).filter((a) => a !== ctx.agent && this.router.allowsOutbound(ctx.agent, a));
    if (peers.length) {
      tools.push({
        name: 'delegate',
        description:
          'Hand a task to another agent and get its answer back. Available: ' +
          peers.map((p) => `${p}${this.cfg.agents[p]?.description ? ` (${this.cfg.agents[p]!.description})` : ''}`).join(', '),
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string', enum: peers }, task: { type: 'string' } },
          required: ['agent', 'task'],
        },
      });
    }
    for (const server of this.tools.serverNames()) {
      if (!this.router.mayReachServer(ctx.agent, server)) continue; // don't spawn servers the agent can't use
      let list: Tool[];
      try {
        list = await this.tools.listTools(server);
      } catch (err) {
        this.warn(`tool server ${server} unavailable: ${(err as Error).message}`);
        continue;
      }
      for (const t of list) {
        if (!this.router.allowsOutbound(ctx.agent, `${server}.${t.name}`)) continue;
        tools.push({ ...t, name: `${server}__${t.name}`, description: `[${server}] ${t.description ?? ''}`.trim() });
      }
    }
    return tools;
  }

  async callTool(grant: SessionGrant, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const ctx = this.active.get(grant);
    if (!ctx || ctx.controller.signal.aborted) return { text: 'this turn has ended', isError: true };
    this.trace(ctx.sessionKey, 'tool_call', ctx.agent, { name, args });

    switch (name) {
      case 'send_message': {
        await this.send(ctx.thread, String(args.text ?? ''));
        return { text: 'sent' };
      }
      case 'ask_human': {
        const asked = args.timeout_minutes;
        const minutes =
          typeof asked === 'number' && Number.isFinite(asked) && asked > 0
            ? Math.min(ASK_MINUTES.max, Math.max(ASK_MINUTES.min, asked))
            : ASK_MINUTES.default;
        // Listen before asking, so even an instant reply is caught.
        const waiting = this.waitFor(ctx.rootKey, [ctx.envelope.initiator], minutes * 60e3, () => true, ctx.controller.signal);
        try {
          await this.send(ctx.thread, `❓ ${ctx.agent} asks: ${String(args.question ?? '')}`);
        } catch (err) {
          waiting.cancel('the question could not be sent');
          throw err;
        }
        const answer = await waiting.answer;
        if (answer) return { text: answer.text };
        return { text: ctx.controller.signal.aborted ? 'this turn has ended' : `no answer within ${minutes} minutes`, isError: true };
      }
      case 'delegate':
        return this.delegate(ctx, String(args.agent ?? ''), String(args.task ?? ''));
    }

    const sep = name.indexOf('__');
    if (sep < 0) return { text: `unknown tool ${name}`, isError: true };
    const server = name.slice(0, sep);
    const tool = name.slice(sep + 2);
    const qualified = `${server}.${tool}`;
    if (!this.router.allowsOutbound(ctx.agent, qualified)) {
      return { text: `${ctx.agent} is not routed to ${qualified}`, isError: true };
    }
    const rule = this.policies.approvalFor(ctx.agent, qualified, { readOnly: await this.tools.isReadOnly(server, tool) });
    if (rule) {
      const approvers = this.approvers(rule.approvers, ctx.envelope);
      if (!approvers.length) {
        this.trace(ctx.sessionKey, 'approval', 'nobody', { tool: qualified, approved: false });
        return { text: `${qualified} needs an approval, but no configured person may give it (add a person with trust: owner)`, isError: true };
      }
      const expires = rule.timeoutMs < 60e3 ? `${Math.round(rule.timeoutMs / 1e3)}s` : `${Math.round(rule.timeoutMs / 60e3)}m`;
      const header = `🔐 ${ctx.agent} wants to run \`${qualified}\` with:`;
      const footer = `${approvers.join(', ')} can decide (expires in ${expires}).`;
      const im = this.ims.get(ctx.thread.platform);
      // Buttons go in one message, so long arguments are cut there; typed approvals are split like any reply.
      const room = im?.sendChoice ? im.maxTextLength - header.length - footer.length - 120 : Infinity;
      const decision = await this.choose({
        key: ctx.rootKey,
        thread: ctx.thread,
        text: `${header}\n${codeBlock(JSON.stringify(args, null, 2), room)}\n${footer}`,
        choices: [
          { label: 'Approve', value: 'approve', style: 'primary' },
          { label: 'Deny', value: 'deny', style: 'danger' },
        ],
        allowed: approvers,
        timeoutMs: rule.timeoutMs,
        typedHint: 'Reply "approve" or "deny".',
        typed: (t) => (APPROVE.test(t) ? 'approve' : DENY.test(t) ? 'deny' : undefined),
        outcome: (r) => (!r ? '⌛ Approval expired.' : r.value === 'approve' ? `✅ Approved by ${r.by}.` : `🚫 Denied by ${r.by}.`),
        signal: ctx.controller.signal,
      });
      // An approval that lands after the turn ended must not run the tool for nobody.
      if (ctx.controller.signal.aborted) return { text: 'this turn has ended', isError: true };
      const approved = decision?.value === 'approve';
      this.trace(ctx.sessionKey, 'approval', decision?.by ?? 'timeout', { tool: qualified, approved });
      if (!approved) return { text: decision ? `denied by ${decision.by}` : 'approval timed out', isError: true };
    }
    const result = await this.tools.callTool(server, tool, args);
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    this.trace(ctx.sessionKey, 'tool_result', qualified, { text, isError: result.isError });
    return { text, isError: Boolean(result.isError) };
  }

  /**
   * Who may approve: configured people who are not `external`. `initiator` counts only when the chain was
   * started by such a person (and nothing in it is tainted); otherwise the owners decide instead, so nobody
   * outside the trusted set ever approves their own request.
   */
  private approvers(names: string[], envelope: Envelope): string[] {
    const trusted = (id: string) => Object.hasOwn(this.cfg.people, id) && this.cfg.people[id]!.trust !== 'external';
    const out = new Set<string>();
    for (const name of names) {
      if (name !== 'initiator') {
        if (trusted(name)) out.add(name);
      } else if (!envelope.tainted && trusted(envelope.initiator)) {
        out.add(envelope.initiator);
      } else {
        for (const [id, p] of Object.entries(this.cfg.people)) if (p.trust === 'owner') out.add(id);
      }
    }
    return [...out];
  }

  private async delegate(ctx: TurnCtx, target: string, task: string): Promise<ToolResult> {
    if (!Object.hasOwn(this.cfg.agents, target)) return { text: `unknown agent "${target}"`, isError: true };
    if (!this.router.allowsOutbound(ctx.agent, target)) {
      return { text: `${ctx.agent} is not routed to ${target}`, isError: true };
    }
    const hops = ctx.envelope.hops + 1;
    const limit = Math.min(this.policies.maxHops(ctx.agent), this.policies.maxHops(target));
    if (hops > limit) return { text: `delegation stopped: ${hops} hops exceeds the limit of ${limit}`, isError: true };

    // One delegated session per target and conversation: a second task waits for the first one's answer.
    const childKey = `${ctx.sessionKey}>${target}`;
    if (this.delegating.has(childKey)) {
      return { text: `${target} is still working on an earlier task from ${ctx.agent} — wait for its answer, then delegate again`, isError: true };
    }
    this.delegating.add(childKey);
    try {
      const existing = await this.store.getSession(childKey);
      await this.store.upsertSession({
        key: childKey,
        agent: target,
        agent_session_id: existing?.agent_session_id ?? null,
        platform: ctx.thread.platform,
        channel_id: ctx.thread.channelId,
        thread_id: ctx.thread.threadId,
        initiator: ctx.envelope.initiator,
      });
      const envelope = newEnvelope({
        sender: { kind: 'agent', name: ctx.agent },
        sessionKey: childKey,
        content: [{ type: 'text', text: task }],
        trust: minTrust(ctx.envelope.trust, 'agent'),
        initiator: ctx.envelope.initiator,
        hops,
        budgetUsd: ctx.envelope.budgetUsd,
        tainted: ctx.envelope.tainted,
      });
      await this.notify(ctx.thread, `↪️ ${ctx.agent} → ${target}: ${task.length > 200 ? task.slice(0, 197) + '…' : task}`);
      this.trace(childKey, 'delegate', ctx.agent, { target, task, hops });
      const reply = await this.invoke(
        { sessionKey: childKey, rootKey: ctx.rootKey, agent: target, envelope, thread: ctx.thread },
        task,
        existing?.agent_session_id ?? undefined,
        { parent: ctx.controller.signal },
      );
      return { text: reply.text };
    } finally {
      this.delegating.delete(childKey);
    }
  }

  async status() {
    return {
      startedAt: this.startedAt,
      ims: [...this.ims.keys()],
      agents: Object.keys(this.cfg.agents),
      tools: Object.keys(this.cfg.tools),
      activeTurns: [...this.active.values()].map((c) => ({ session: c.sessionKey, agent: c.agent })),
      sessions: (await this.store.listSessions(20)).map((s) => ({ key: s.key, agent: s.agent, lastActive: s.last_active, spentUsd: s.spent_usd })),
    };
  }

  // ───────────────────────── for the app: conversations, choices, branches, tools ─────────────────────────

  /** Recent conversations, most recently active first, with the branch status of agents that keep one. */
  async sessions(limit = 200): Promise<SessionInfo[]> {
    const busy = new Set([...this.active.values()].map((c) => c.rootKey));
    let lookups = 0;
    return Promise.all((await this.store.listSessions(limit)).map(async (s) => {
      // Branch status runs git, so only the most recent conversations of agents with branches get it, and
      // it is cached briefly (turn ends, merges and discards refresh it).
      const ws = Object.hasOwn(this.cfg.agents, s.agent) ? this.agent(s.agent).workspace : undefined;
      const { branch, canMerge } = ws && lookups++ < BRANCH_LOOKUPS ? await this.branchInfo(s.key, ws) : { branch: undefined, canMerge: false };
      return {
        key: s.key,
        agent: s.agent,
        platform: s.platform,
        initiator: s.initiator,
        createdAt: s.created_at,
        lastActive: s.last_active,
        spentUsd: s.spent_usd,
        busy: busy.has(s.key) || this.chains.has(s.key),
        branch,
        canMerge,
      };
    }));
  }

  private async branchInfo(key: string, ws: Workspace): Promise<{ branch?: string; canMerge: boolean }> {
    const cached = this.branchCache.get(key);
    if (cached && Date.now() - cached.at < BRANCH_CACHE_MS) return cached;
    let info: { branch?: string; canMerge: boolean };
    try {
      const branch = await ws.status(key);
      info = { branch, canMerge: !!branch && (await ws.previewMerge(key)).ok };
    } catch (err) {
      this.warn(`branch status for ${key} failed: ${(err as Error).message}`);
      info = { canMerge: false };
    }
    for (const [k, v] of this.branchCache) if (Date.now() - v.at >= BRANCH_CACHE_MS) this.branchCache.delete(k);
    this.branchCache.set(key, { at: Date.now(), ...info });
    return info;
  }

  /** The audit trail, newest first: one conversation's, or everything. Details are redacted JSON. */
  async auditTrail(opts: { sessionKey?: string; limit: number }): Promise<AuditEntry[]> {
    await this.flushWrites();
    return (await this.store.readTrace(opts))
      .reverse()
      .map((t) => ({ ts: t.ts, session: t.session_key, kind: t.kind, actor: t.actor, detail: t.detail }));
  }

  /** Approvals and confirmations waiting for someone (questions asked with `askInDms` are not listed). */
  pendingChoices(): PendingChoice[] {
    return [...this.choices.entries()].filter(([, c]) => c.listed).map(([id, c]) => ({
      id,
      key: c.key,
      text: c.text,
      choices: c.options.map((o) => ({ label: o.label, value: o.value, style: o.style })),
      allowed: [...c.allowed],
      createdAt: c.at,
    }));
  }

  /**
   * Decide a pending choice as `person` (a key of cfg.people), outside the chat. `via` says where (e.g. "web")
   * for the audit trail. Throws when the choice is gone or the person may not decide it.
   */
  decide(id: string, value: string, person: string, via: string) {
    const choice = this.choices.get(id);
    if (!choice) throw new Error('this choice has already been decided or has expired');
    if (!choice.options.some((o) => o.value === value)) throw new Error(`"${value}" is not one of the options`);
    if (!choice.allowed.has(person)) throw new Error(`only ${[...choice.allowed].join(', ')} can decide this`);
    choice.settle({ by: `${person} (${via})`, value });
  }

  /**
   * Merge or discard a conversation's branch as `person`, outside the chat. With `preview`, say what it would do;
   * otherwise do it behind the conversation's queue (never in the middle of a turn) and tell the thread.
   */
  async branchAction(key: string, action: 'merge' | 'discard', opts: { preview?: boolean; person: string; via: string }): Promise<string> {
    const session = await this.store.getSession(key);
    if (!session) throw new Error('no such conversation');
    const ws = this.agent(session.agent).workspace;
    if (!ws) throw new Error(`${session.agent} has no branches (worktree is off)`);
    if (opts.preview) {
      if (action === 'merge') {
        const p = await ws.previewMerge(key);
        if (!p.ok) throw new Error(p.reason);
        return p.summary;
      }
      const lost = await ws.previewDiscard(key);
      if (lost === undefined) throw new Error('this conversation has no branch');
      return lost ? `This throws away ${lost}` : 'Nothing unmerged — the branch and its worktree are removed.';
    }
    const by = `${opts.person} (${opts.via})`;
    const thread: ThreadRef = { platform: session.platform, channelId: session.channel_id, threadId: session.thread_id, isDM: isDmKey(key) };
    const done = Promise.withResolvers<string>();
    this.schedule(key, async () => {
      try {
        if (this.stopping) throw new Error('the bridge is shutting down');
        if (action === 'merge') {
          const p = await ws.previewMerge(key);
          if (!p.ok) throw new Error(p.reason);
        }
        const result = action === 'merge' ? await ws.merge(key) : await ws.discard(key);
        await this.store.deleteSession(key);
        this.trace(key, action === 'merge' ? 'merged' : 'discarded', by, { result });
        await this.notify(thread, `${result}\n_(by ${opts.person}, via ${opts.via})_`);
        done.resolve(result);
      } catch (err) {
        done.reject(err);
      } finally {
        this.branchCache.delete(key);
      }
    });
    return done.promise;
  }

  /** Each tool server with its tool count, or why it can't be reached (an answer within TOOL_STATUS_MS). */
  async toolServers(): Promise<ToolServerInfo[]> {
    return Promise.all(
      Object.entries(this.cfg.tools).map(async ([name, cfg]): Promise<ToolServerInfo> => {
        const base: ToolServerInfo = {
          name,
          kind: 'url' in cfg ? 'http' : 'stdio',
          target: 'url' in cfg ? cfg.url : [cfg.command, ...cfg.args].join(' '),
          oauth: this.oauth.status(name),
        };
        if (base.oauth === 'signed-out') return base;
        const timeout = AbortSignal.timeout(TOOL_STATUS_MS);
        try {
          const list = await Promise.race([
            this.tools.listTools(name),
            new Promise<never>((_, reject) =>
              timeout.addEventListener('abort', () => reject(new Error(`no answer in ${TOOL_STATUS_MS / 1000}s`)), { once: true }),
            ),
          ]);
          return { ...base, tools: list.length };
        } catch (err) {
          return { ...base, error: (err as Error).message };
        }
      }),
    );
  }

  /**
   * Ask `people` (keys of cfg.people) a question in their direct messages with the bot, on every IM where they
   * have one, with buttons where the IM has them and typed replies everywhere. Whoever answers first decides;
   * `outcome` turns the answer into the text each message is updated with. Aborting `signal` withdraws the
   * question (its reason, when an Error, is shown). Resolves to the number of DMs asked; 0 means nobody could be
   * reached yet (a DM exists once the person has written to the bot).
   */
  async askInDms(opts: {
    people: string[];
    text: string;
    choices: Choice[];
    typedHint: string;
    typed: (text: string) => string | undefined;
    outcome: (r: { by: string; value: string } | undefined) => string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<number> {
    let asked = 0;
    for (const id of opts.people) {
      const person = Object.hasOwn(this.cfg.people, id) ? this.cfg.people[id] : undefined;
      if (!person) continue;
      for (const platform of this.ims.keys()) {
        const userId = personIdOn(person, platform);
        if (userId === undefined) continue;
        const key = dmKey(platform, userId);
        const dm = await this.store.getSession(key);
        if (!dm) continue;
        asked++;
        this.choose({
          key,
          thread: { platform, channelId: dm.channel_id, threadId: dm.thread_id, isDM: true },
          text: opts.text,
          choices: opts.choices,
          allowed: opts.people,
          timeoutMs: opts.timeoutMs,
          typedHint: opts.typedHint,
          typed: opts.typed,
          outcome: opts.outcome,
          signal: opts.signal,
          unlisted: true,
        }).catch((err) => this.warn(`question not sent to ${key}: ${(err as Error).message}`));
      }
    }
    return asked;
  }

  // ───────────────────────── helpers ─────────────────────────

  private log(line: string) {
    this.logLine(line, 'info');
  }

  private warn(line: string) {
    this.logLine(line, 'error');
  }

  private agent(name: string): AgentAdapter {
    let a = this.agents.get(name);
    if (!a) {
      const cfg = Object.hasOwn(this.cfg.agents, name) ? this.cfg.agents[name] : undefined;
      if (!cfg) throw new Error(`unknown agent "${name}"`);
      a = this.agentFactory(name, cfg, { secrets: this.secrets, tempDir: this.tempDir });
      this.agents.set(name, a);
    }
    return a;
  }

  private person(platform: string, userId: string): { id: string; trust: TrustLevel } | undefined {
    if (platform === 'local') {
      const p = Object.hasOwn(this.cfg.people, userId) ? this.cfg.people[userId] : undefined;
      return p ? { id: userId, trust: p.trust } : undefined;
    }
    for (const [id, p] of Object.entries(this.cfg.people)) {
      if (personIdOn(p, platform) === userId) return { id, trust: p.trust };
    }
    return undefined;
  }

  /**
   * Ask the thread to decide. With buttons where the IM has them, otherwise (and always also) by
   * typed reply. Only `allowed` people count; the message is updated with the outcome.
   */
  private async choose(opts: {
    key: string;
    thread: ThreadRef;
    text: string;
    choices: Choice[];
    allowed: string[];
    timeoutMs: number;
    typedHint: string;
    typed: (text: string) => string | undefined;
    outcome: (r: { by: string; value: string } | undefined) => string;
    /** Aborting it cancels the choice: the turn that asked has ended, or an Error reason says why. */
    signal?: AbortSignal;
    /** Leave it out of `pendingChoices`. */
    unlisted?: boolean;
  }): Promise<{ by: string; value: string } | undefined> {
    const im = this.ims.get(opts.thread.platform);
    const id = randomUUID().slice(0, 8);
    const allowed = new Set(opts.allowed);
    const decided = Promise.withResolvers<{ by: string; value: string } | undefined>();
    let settled = false;
    let cancelled: string | undefined;
    const settle = (r: { by: string; value: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      this.choices.delete(id);
      this.dropWaiter(opts.key, waiter);
      decided.resolve(r);
    };
    const waiter: Waiter = {
      allowed,
      accepts: (t) => opts.typed(t.trim()) !== undefined,
      offer: (personId, t) => {
        const value = opts.typed(t.trim());
        if (!allowed.has(personId) || value === undefined) return false;
        settle({ by: personId, value });
        return true;
      },
      cancel: (reason) => {
        if (settled) return;
        cancelled = reason;
        settle(undefined);
      },
    };
    const onAbort = () => {
      const reason = opts.signal?.reason;
      waiter.cancel(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : 'the turn has ended');
    };
    const timer = setTimeout(() => settle(undefined), opts.timeoutMs);
    // Registered before the prompt goes out, so even an instant click or reply counts.
    this.choices.set(id, { allowed, settle, key: opts.key, text: opts.text, options: opts.choices, at: Date.now(), listed: !opts.unlisted });
    this.addWaiter(opts.key, waiter);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    let messageId: string | undefined;
    try {
      if (im?.sendChoice) {
        messageId = await im.sendChoice(
          { channelId: opts.thread.channelId, threadId: opts.thread.threadId, isDM: opts.thread.isDM, text: opts.text },
          opts.choices.map((c) => ({ ...c, value: `${id}|${c.value}` })),
        );
      } else {
        await this.send(opts.thread, `${opts.text}\n${opts.typedHint}`);
      }
    } catch (err) {
      waiter.cancel('the question could not be sent');
      throw err;
    }

    const result = await decided.promise;
    const outcome = cancelled ? `✖ Cancelled: ${cancelled}.` : opts.outcome(result);
    this.trace(opts.key, 'choice', result?.by ?? (cancelled ? 'cancelled' : 'timeout'), { value: result?.value ?? null, outcome, buttons: !!messageId });
    try {
      if (messageId && im?.resolveChoice) {
        await im.resolveChoice(opts.thread.channelId, messageId, opts.text, outcome).catch(() => this.send(opts.thread, outcome));
      } else {
        await this.send(opts.thread, outcome);
      }
    } catch (err) {
      this.warn(`outcome of choice in ${opts.key} not delivered: ${(err as Error).message}`);
    }
    return result;
  }

  /** A button click: settle the choice if the clicker may decide. */
  async handleAction(action: InboundAction) {
    const [id, value] = action.value.split('|');
    const im = this.ims.get(action.platform);
    const choice = id ? this.choices.get(id) : undefined;
    if (!choice || value === undefined) {
      await im?.notifyUser?.(action.channelId, action.userId, 'This choice has already been decided or has expired.');
      return;
    }
    const person = this.person(action.platform, action.userId);
    if (!person || !choice.allowed.has(person.id)) {
      await im?.notifyUser?.(action.channelId, action.userId, `Only ${[...choice.allowed].join(', ')} can decide this.`);
      return;
    }
    choice.settle({ by: person.id, value });
  }

  /**
   * Wait for a typed reply from one of `allowed` in conversation `key`. Registers at once (call it before
   * asking); `answer` is undefined on timeout, cancel, or when `signal` aborts.
   */
  private waitFor(
    key: string,
    allowed: string[],
    timeoutMs: number,
    accepts: (text: string) => boolean,
    signal?: AbortSignal,
  ): { answer: Promise<{ by: string; text: string } | undefined>; cancel: (reason: string) => void } {
    const answered = Promise.withResolvers<{ by: string; text: string } | undefined>();
    let settled = false;
    const done = (v: { by: string; text: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.dropWaiter(key, waiter);
      answered.resolve(v);
    };
    const waiter: Waiter = {
      allowed: new Set(allowed),
      accepts: (text) => accepts(text.trim()),
      offer: (personId, text) => {
        if (!waiter.allowed.has(personId) || !accepts(text.trim())) return false;
        done({ by: personId, text: text.trim() });
        return true;
      },
      cancel: () => done(undefined),
    };
    const onAbort = () => done(undefined);
    const timer = setTimeout(() => done(undefined), timeoutMs);
    this.addWaiter(key, waiter);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return { answer: answered.promise, cancel: waiter.cancel };
  }

  private addWaiter(key: string, waiter: Waiter) {
    this.waiters.set(key, [...(this.waiters.get(key) ?? []), waiter]);
  }

  private dropWaiter(key: string, waiter: Waiter) {
    const list = (this.waiters.get(key) ?? []).filter((w) => w !== waiter);
    if (list.length) this.waiters.set(key, list);
    else this.waiters.delete(key);
  }

  /** 'consumed' when a waiter took the message; the allowed people when someone else tried to answer. */
  private offerToWaiters(key: string, personId: string, text: string): 'consumed' | string[] | undefined {
    const list = [...(this.waiters.get(key) ?? [])];
    for (const w of list) if (w.offer(personId, text)) return 'consumed';
    // Approval words from the wrong person are answered, not turned into a new agent turn.
    const t = text.trim();
    if (!APPROVE.test(t) && !DENY.test(t)) return undefined;
    const blocked = list.find((w) => w.accepts(t));
    return blocked ? [...blocked.allowed] : undefined;
  }

  private async send(thread: ThreadRef, text: string): Promise<string | undefined> {
    const im = this.ims.get(thread.platform);
    if (!im) return undefined;
    let last: string | undefined;
    for (const chunk of split(text, im.maxTextLength)) {
      last = await im.send({ channelId: thread.channelId, threadId: thread.threadId, isDM: thread.isDM, text: chunk });
    }
    return last;
  }

  /** A message whose delivery is not essential: a failure is logged, never thrown. */
  private async notify(thread: ThreadRef, text: string): Promise<void> {
    try {
      await this.send(thread, text);
    } catch (err) {
      this.warn(`message to ${thread.platform}:${thread.channelId} not delivered: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Final reply: replace the progress placeholder when the IM can edit, otherwise post fresh. */
  private async post(thread: ThreadRef, text: string, placeholder?: string) {
    const im = this.ims.get(thread.platform);
    if (!im) return;
    const chunks = split(text, im.maxTextLength);
    let start = 0;
    if (placeholder && im.edit) {
      try {
        await im.edit(thread.channelId, placeholder, chunks[0]!);
        start = 1;
      } catch {
        /* fall back to posting */
      }
    }
    for (const chunk of chunks.slice(start)) {
      await im.send({ channelId: thread.channelId, threadId: thread.threadId, isDM: thread.isDM, text: chunk });
    }
  }
}


/**
 * `text` (JSON) as a code block that nothing inside can close: backticks become the JSON escape `.
 * Longer than `max` characters, it is cut with a note saying how much is missing and where to see it all.
 */
export function codeBlock(json: string, max = Infinity): string {
  let body = json.replace(/`/g, '\\u0060');
  if (body.length > max) {
    const keep = Math.max(0, Math.floor(max));
    body = `${body.slice(0, keep)}\n… +${body.length - keep} more characters (all of them are in the audit trail)`;
  }
  return '```\n' + body + '\n```';
}

/** Split long replies at line breaks; a code fence cut in two is closed and reopened. */
export function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  let reopen = '';
  while (rest.length) {
    const room = max - reopen.length - 4;
    let cut = rest.length;
    if (rest.length > room) {
      cut = rest.lastIndexOf('\n', room);
      if (cut < room * 0.5) cut = room;
    }
    let chunk = reopen + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');
    const fences = chunk.split('\n').filter((l) => /^\s*(```|~~~)/.test(l));
    const open = fences.length % 2 === 1;
    if (open && rest.length) {
      chunk += '\n```';
      reopen = '```\n';
    } else reopen = '';
    out.push(chunk);
  }
  return out;
}

/** A turn not started because the conversation budget can't cover it; `detail` goes to the audit trail. */
class BudgetRefusal extends Error {
  readonly detail: Record<string, number>;
  constructor(message: string, detail: Record<string, number>) {
    super(message);
    this.detail = detail;
  }
}
