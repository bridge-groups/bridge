import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** How many of an agent's latest turns `cheapestRecentTurn` looks at. */
const RECENT_TURNS = 20;

export interface SessionRow {
  key: string;
  /** The agent holding the conversation: a message that names no agent goes to it. */
  agent: string;
  platform: string;
  channel_id: string;
  thread_id: string;
  initiator: string;
  created_at: number;
  last_active: number;
  spent_usd: number;
}

export interface QueueRow {
  id: string;
  /** `expired`: `takePending` just gave up on it (see there). */
  status: 'pending' | 'running' | 'expired';
  session_key: string;
  payload: string;
  created_at: number;
}

export interface TraceRow {
  id: number;
  ts: number;
  session_key: string;
  kind: string;
  actor: string;
  detail: string;
}

type Awaitable<T> = T | Promise<T>;

/**
 * Where a bridge keeps its state: conversations (sessions) with each agent's own session id in them, the inbound
 * queue that survives restarts, and the audit trail. Methods may return promises, so an embedding app can keep it in its own database; the bridge
 * awaits every call and never runs two writes for one conversation at once. SqliteStore is the default.
 */
export interface BridgeStore {
  getSession(key: string): Awaitable<SessionRow | undefined>;
  /** Create or update a conversation; `last_active` becomes now. */
  upsertSession(s: Omit<SessionRow, 'created_at' | 'last_active' | 'spent_usd'>): Awaitable<SessionRow>;
  /** The id `agent` reported for its own session in this conversation, to resume it. */
  agentSession(key: string, agent: string): Awaitable<string | undefined>;
  /** `last_active` becomes now; `agentSession` sets (or with `id: null` forgets) one agent's session id. */
  updateSession(key: string, patch: { agentSession?: { agent: string; id: string | null }; addSpentUsd?: number }): Awaitable<void>;
  /** Delete a conversation, its agents' session ids and the conversations it delegated to (keys starting with `<key>>`). */
  deleteSession(key: string): Awaitable<void>;
  /** Keys of conversations active at or after `since`. */
  sessionsActiveSince(since: number): Awaitable<string[]>;
  /** Most recently active first. */
  listSessions(limit?: number): Awaitable<SessionRow[]>;
  enqueue(id: string, sessionKey: string, payload: unknown): Awaitable<void>;
  markRunning(id: string, payload: unknown): Awaitable<void>;
  finish(id: string, status: 'done' | 'failed'): Awaitable<void>;
  /**
   * Queue entries still pending or running, oldest first. Ones older than `ttlMs` are marked expired instead; those
   * marked by this call are returned too, with status `expired`, so the bridge can tell their senders.
   */
  takePending(ttlMs: number): Awaitable<QueueRow[]>;
  /**
   * Retention: finished queue rows created before `queueBefore`; trace entries and conversations idle since before
   * `historyBefore`; spending recorded before `spendingBefore` (omit either to keep those).
   */
  prune(opts: { queueBefore: number; historyBefore?: number; spendingBefore?: number }): Awaitable<{ queue: number; trace: number; sessions: number }>;
  /** Append to the audit trail. `detail` is JSON the bridge has already cleared of credentials. */
  trace(sessionKey: string, kind: string, actor: string, detail: string): Awaitable<void>;
  /** Record what a turn begun by `sender` (someone outside `people`, as "platform:userId") cost. */
  addSpending(sender: string, usd: number): Awaitable<void>;
  /** What `sender` spent since `since`, oldest first. */
  spendingSince(sender: string, since: number): Awaitable<{ ts: number; usd: number }[]>;
  /** Each sender's total since `since`, highest first. */
  spendersSince(since: number, limit?: number): Awaitable<{ sender: string; usd: number }[]>;
  /** The cheapest of `agent`'s last 20 replies that reported a cost (`kind: reply`, `detail.costUsd`). */
  cheapestRecentTurn(agent: string): Awaitable<number | undefined>;
  /** Oldest first: the last `limit` entries, of one conversation or of all, of the given kinds or of every kind. */
  readTrace(opts?: { sessionKey?: string; kinds?: string[]; limit?: number }): Awaitable<TraceRow[]>;
  close(): Awaitable<void>;
}

/** SQLite holds sessions, the inbound queue and the audit trace. Pass ":memory:" in tests. */
export class SqliteStore implements BridgeStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- agent_session_id is no longer read: before agent_sessions it held one id per conversation, which could be
      -- another agent's, so those ids are dropped and every conversation's agents start fresh sessions once.
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session_id TEXT,
        platform TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        initiator TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON queue(status, created_at);
      CREATE TABLE IF NOT EXISTS trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_key TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_session ON trace(session_key, id);
      CREATE INDEX IF NOT EXISTS trace_ts ON trace(ts);
      CREATE INDEX IF NOT EXISTS sessions_active ON sessions(last_active);
      -- What turns begun by senders outside people cost, for their limit over a rolling window.
      CREATE TABLE IF NOT EXISTS spending (ts INTEGER NOT NULL, sender TEXT NOT NULL, usd REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS spending_sender ON spending(sender, ts);
      CREATE INDEX IF NOT EXISTS spending_ts ON spending(ts);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_key TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (session_key, agent)
      );
    `);
  }

  getSession(key: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as SessionRow | undefined;
  }

  upsertSession(s: Omit<SessionRow, 'created_at' | 'last_active' | 'spent_usd'>): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (key, agent, platform, channel_id, thread_id, initiator, created_at, last_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent = excluded.agent, last_active = excluded.last_active`,
      )
      .run(s.key, s.agent, s.platform, s.channel_id, s.thread_id, s.initiator, now, now);
    return this.getSession(s.key)!;
  }

  agentSession(key: string, agent: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM agent_sessions WHERE session_key = ? AND agent = ?').get(key, agent) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  updateSession(key: string, patch: { agentSession?: { agent: string; id: string | null }; addSpentUsd?: number }) {
    const now = Date.now();
    const { agentSession } = patch;
    if (agentSession?.id) {
      this.db
        .prepare('INSERT INTO agent_sessions (session_key, agent, id) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET id = excluded.id')
        .run(key, agentSession.agent, agentSession.id);
    } else if (agentSession) {
      this.db.prepare('DELETE FROM agent_sessions WHERE session_key = ? AND agent = ?').run(key, agentSession.agent);
    }
    this.db
      .prepare('UPDATE sessions SET last_active = ?, spent_usd = spent_usd + ? WHERE key = ?')
      .run(now, patch.addSpentUsd ?? 0, key);
  }

  /** Forget a conversation together with its delegation sessions (`<key>>agent`, `<key>>a>b`, …). */
  deleteSession(key: string) {
    const prefix = `${key}>`;
    this.db
      .prepare('DELETE FROM sessions WHERE key = ? OR substr(key, 1, ?) = ?')
      .run(key, prefix.length, prefix);
    this.db
      .prepare('DELETE FROM agent_sessions WHERE session_key = ? OR substr(session_key, 1, ?) = ?')
      .run(key, prefix.length, prefix);
  }

  /** Keys of the sessions active after `since` (ms epoch). */
  sessionsActiveSince(since: number): string[] {
    return (this.db.prepare('SELECT key FROM sessions WHERE last_active > ?').all(since) as { key: string }[]).map(
      (r) => r.key,
    );
  }

  listSessions(limit = 50): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?').all(limit) as unknown as SessionRow[];
  }

  enqueue(id: string, sessionKey: string, payload: unknown) {
    this.db
      .prepare('INSERT INTO queue (id, session_key, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(id, sessionKey, JSON.stringify(payload), Date.now());
  }

  /** A turn has started; `payload` is saved so a crash can resume it. */
  markRunning(id: string, payload: unknown) {
    this.db.prepare(`UPDATE queue SET status = 'running', payload = ? WHERE id = ?`).run(JSON.stringify(payload), id);
  }

  finish(id: string, status: 'done' | 'failed') {
    this.db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Work left over from a previous run: `pending` never started, `running` was cut off mid-turn.
   * Anything older than `ttlMs` is expired instead.
   */
  takePending(ttlMs: number): QueueRow[] {
    const cutoff = Date.now() - ttlMs;
    const expired = this.db
      .prepare(
        `UPDATE queue SET status = 'expired' WHERE status IN ('pending', 'running') AND created_at < ?
         RETURNING id, status, session_key, payload, created_at`,
      )
      .all(cutoff) as unknown as QueueRow[];
    const live = this.db
      .prepare(
        `SELECT id, status, session_key, payload, created_at FROM queue WHERE status IN ('pending', 'running') ORDER BY created_at`,
      )
      .all() as unknown as QueueRow[];
    return [...expired, ...live].sort((a, b) => a.created_at - b.created_at);
  }

  /** See BridgeStore.prune. Returns how many queue rows, trace entries and sessions went. */
  prune(opts: { queueBefore: number; historyBefore?: number; spendingBefore?: number }): { queue: number; trace: number; sessions: number } {
    const queue = this.db
      .prepare(`DELETE FROM queue WHERE status IN ('done', 'failed', 'expired') AND created_at < ?`)
      .run(opts.queueBefore).changes;
    if (opts.spendingBefore !== undefined) this.db.prepare('DELETE FROM spending WHERE ts < ?').run(opts.spendingBefore);
    if (opts.historyBefore === undefined) return { queue: Number(queue), trace: 0, sessions: 0 };
    const trace = this.db.prepare('DELETE FROM trace WHERE ts < ?').run(opts.historyBefore).changes;
    const sessions = this.db.prepare('DELETE FROM sessions WHERE last_active < ?').run(opts.historyBefore).changes;
    this.db.prepare('DELETE FROM agent_sessions WHERE session_key NOT IN (SELECT key FROM sessions)').run();
    return { queue: Number(queue), trace: Number(trace), sessions: Number(sessions) };
  }

  trace(sessionKey: string, kind: string, actor: string, detail: string) {
    this.db
      .prepare('INSERT INTO trace (ts, session_key, kind, actor, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), sessionKey, kind, actor, detail);
  }

  addSpending(sender: string, usd: number) {
    this.db.prepare('INSERT INTO spending (ts, sender, usd) VALUES (?, ?, ?)').run(Date.now(), sender, usd);
  }

  spendingSince(sender: string, since: number): { ts: number; usd: number }[] {
    return this.db
      .prepare('SELECT ts, usd FROM spending WHERE sender = ? AND ts >= ? ORDER BY ts')
      .all(sender, since) as unknown as { ts: number; usd: number }[];
  }

  spendersSince(since: number, limit = 20): { sender: string; usd: number }[] {
    return this.db
      .prepare('SELECT sender, SUM(usd) AS usd FROM spending WHERE ts >= ? GROUP BY sender ORDER BY usd DESC LIMIT ?')
      .all(since, limit) as unknown as { sender: string; usd: number }[];
  }

  /**
   * The cheapest of the agent's last RECENT_TURNS turns that reported a cost (from the audit trail). A turn's
   * fixed overhead (system prompt, tool list, first model request) makes this a floor for what its next turn costs.
   */
  cheapestRecentTurn(agent: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(cost) AS cost FROM (
           SELECT json_extract(detail, '$.costUsd') AS cost FROM trace
           WHERE kind = 'reply' AND actor = ? AND json_extract(detail, '$.costUsd') > 0
           ORDER BY id DESC LIMIT ?)`,
      )
      .get(agent, RECENT_TURNS) as { cost: number | null } | undefined;
    return row?.cost ?? undefined;
  }

  readTrace(opts: { sessionKey?: string; kinds?: string[]; limit?: number } = {}): TraceRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.sessionKey) {
      where.push('session_key = ?');
      args.push(opts.sessionKey);
    }
    if (opts.kinds) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      args.push(...opts.kinds);
    }
    const rows = this.db
      .prepare(`SELECT * FROM trace ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, opts.limit ?? 100);
    return (rows as unknown as TraceRow[]).reverse();
  }

  close() {
    this.db.close();
  }
}
