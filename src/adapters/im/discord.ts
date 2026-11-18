import type { InboundFile, InboundMessage } from '../../core/router.ts';
import { toDiscordMarkdown, truncateDiscord } from './discord-format.ts';
import type { Choice, ImAdapter, InboundAction, OutboundMessage } from './types.ts';

/** Gateway intents (discord.com/developers/docs/events/gateway#gateway-intents). */
const DISCORD_INTENTS = { guildMessages: 1 << 9, directMessages: 1 << 12, messageContent: 1 << 15 };

/** Permissions the bot asks for when invited: see channels, post, read history, open threads and post in them. */
export const DISCORD_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 35n) | (1n << 38n);

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Record<number, string> = {
  4004: 'the bot token was rejected',
  4010: 'invalid shard',
  4011: 'this bot is in too many servers for one connection (sharding is not supported)',
  4012: 'invalid gateway version',
  4013: 'invalid intents',
  4014:
    'the Message Content intent is not enabled for this bot: turn it on in the Developer Portal (Bot → Privileged Gateway Intents) or set im.discord.message_content: false',
};
/** Close codes after which the session cannot be resumed, only started afresh. */
const FRESH_CLOSE = new Set([4007, 4009]);
const THREAD_TYPES = new Set([10, 11, 12]);
/** Discord's limit for a message's content. */
const CONTENT_MAX = 2000;
/** How many sent-message → channel and root → thread-name entries are kept. */
const MAX_KNOWN = 5000;
const CALL_TIMEOUT_MS = 30_000;
/** An interaction token can send follow-ups for this long. */
const INTERACTION_TTL_MS = 15 * 60_000;
const SUPPRESS_EMBEDS = 1 << 2;
const EPHEMERAL = 1 << 6;
/** Nobody is pinged by what an agent writes (`@everyone` and `<@id>` still show, silently). */
const NO_PINGS = { parse: [] };

interface ChannelInfo {
  type: number;
  name: string;
  parentId?: string;
}

class DiscordError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(what: string, status: number, body: { message?: string; code?: number }) {
    super(`discord ${what}: ${body.message ?? `HTTP ${status}`}${body.code ? ` (code ${body.code})` : ''}`);
    this.status = status;
    this.code = body.code;
  }
}

/**
 * Discord over the Gateway (outbound WebSocket, no public URL) and the REST API. In a server channel each
 * conversation is a Discord thread opened from the message that started it (a thread's id is that message's id);
 * DMs are plain messages. Approvals get buttons; progress edits the placeholder in place.
 *
 * Without `messageContent` the bot only sees the text of DMs, messages that @-mention it and replies to it
 * (Discord blanks the rest), so follow-ups in a thread must mention the bot too. The bot it needs is described by
 * `bridge discord setup`.
 */
export class DiscordAdapter implements ImAdapter {
  readonly platform = 'discord';
  readonly maxTextLength = 1900;
  private readonly token: string;
  private readonly api: string;
  private readonly intents: number;
  private gatewayUrl?: string;
  private botId = '';
  private appId = '';

  private ws?: WebSocket;
  private sessionId?: string;
  private resumeUrl?: string;
  private seq: number | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private acked = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private stopped = false;
  private ready?: PromiseWithResolvers<void>;
  /** Inbound events are handled one at a time, so messages reach the bridge in order. */
  private inbound: Promise<void> = Promise.resolve();
  private onMessage: (msg: InboundMessage) => void = () => {};
  private onAction?: (action: InboundAction) => void;

  private readonly channels = new Map<string, Promise<ChannelInfo>>();
  /** Threads known to exist (by id, which is their root message id), or being opened. */
  private readonly threads = new Map<string, Promise<void>>();
  /** Root message id → the name its thread gets. */
  private readonly threadNames = new Map<string, string>();
  /** Message the bot sent → the channel or thread it is in (edits address it there). */
  private readonly channelOf = new Map<string, string>();
  /** "channel:user" → the token of that person's last button click, for a reply only they see. */
  private readonly interactions = new Map<string, { token: string; at: number }>();

  constructor(opts: { botToken: string; messageContent?: boolean; apiBase?: string }) {
    this.token = opts.botToken;
    this.api = opts.apiBase ?? 'https://discord.com/api/v10';
    this.intents = DISCORD_INTENTS.guildMessages | DISCORD_INTENTS.directMessages | (opts.messageContent ? DISCORD_INTENTS.messageContent : 0);
  }

  /** Resolves once the gateway session is ready; rejects when Discord refuses it for good (bad token, intents). */
  async start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void) {
    this.onMessage = onMessage;
    this.onAction = onAction;
    this.botId = (await this.rest<{ id: string }>('GET', '/users/@me')).id;
    this.gatewayUrl = (await this.rest<{ url: string }>('GET', '/gateway/bot')).url;
    this.ready = Promise.withResolvers();
    this.connect();
    await this.ready.promise;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    this.ready?.reject(new Error('discord: stopped before the gateway was ready'));
    await this.inbound;
  }

  async send(msg: OutboundMessage): Promise<string> {
    return this.post(await this.target(msg), { content: render(msg.text) });
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.rest('PATCH', `/channels/${this.channelOf.get(messageId) ?? channelId}/messages/${messageId}`, {
      content: render(text),
      allowed_mentions: NO_PINGS,
    });
  }

  async sendChoice(msg: OutboundMessage, choices: Choice[]): Promise<string> {
    const buttons = choices.map((c) => {
      if (c.value.length > 100) throw new Error(`discord: button value longer than 100 characters: ${c.value.slice(0, 20)}…`);
      return { type: 2, style: c.style === 'primary' ? 1 : c.style === 'danger' ? 4 : 2, label: c.label.slice(0, 80), custom_id: c.value };
    });
    if (buttons.length > 25) throw new Error('discord: at most 25 buttons fit on a message');
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    return this.post(await this.target(msg), { content: render(msg.text), components: rows });
  }

  async resolveChoice(channelId: string, messageId: string, text: string, outcome: string) {
    const note = toDiscordMarkdown(outcome)
      .split('\n')
      .map((l) => (l.trim() ? `-# ${l}` : l))
      .join('\n');
    const content = `${truncateDiscord(toDiscordMarkdown(text), CONTENT_MAX - note.length - 1)}\n${note}`;
    await this.rest('PATCH', `/channels/${this.channelOf.get(messageId) ?? channelId}/messages/${messageId}`, {
      content: truncateDiscord(content, CONTENT_MAX),
      components: [],
      allowed_mentions: NO_PINGS,
    });
  }

  /** Only the clicker sees it: a follow-up to their button click (an ephemeral message). */
  async notifyUser(channelId: string, userId: string, text: string) {
    const click = this.interactions.get(`${channelId}:${userId}`);
    if (click && Date.now() - click.at < INTERACTION_TTL_MS) {
      await this.rest(
        'POST',
        `/webhooks/${this.appId}/${click.token}`,
        { content: render(text), flags: EPHEMERAL, allowed_mentions: NO_PINGS },
        'interaction follow-up',
      );
      return;
    }
    // No click to answer: say it in the channel, addressed to them.
    await this.rest('POST', `/channels/${channelId}/messages`, { content: render(`<@${userId}> ${text}`), allowed_mentions: { users: [userId] } });
  }

  /** Where a reply goes: the DM channel, or the conversation's thread (opened from its root message on first use). */
  private async target(msg: OutboundMessage): Promise<string> {
    if (msg.isDM) return msg.channelId;
    let opened = this.threads.get(msg.threadId);
    if (!opened) {
      opened = this.openThread(msg.channelId, msg.threadId);
      remember(this.threads, msg.threadId, opened);
      opened.catch(() => this.threads.delete(msg.threadId));
    }
    await opened;
    return msg.threadId;
  }

  private async openThread(channelId: string, rootId: string) {
    const name = this.threadNames.get(rootId) ?? 'Conversation';
    try {
      await this.rest('POST', `/channels/${channelId}/messages/${rootId}/threads`, { name });
    } catch (err) {
      // A thread from this message exists already (opened before a restart, or by a person): use it.
      if (err instanceof DiscordError && err.code === 160004) return;
      throw new Error(`could not open a thread for the reply (does the bot have Create Public Threads here?): ${(err as Error).message}`);
    }
  }

  private async post(channel: string, body: object): Promise<string> {
    const sent = await this.rest<{ id: string }>('POST', `/channels/${channel}/messages`, {
      ...body,
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: NO_PINGS,
    });
    remember(this.channelOf, sent.id, channel);
    return sent.id;
  }

  // ---- Gateway ----

  private connect() {
    const url = new URL((this.sessionId && this.resumeUrl) || this.gatewayUrl!);
    url.searchParams.set('v', '10');
    url.searchParams.set('encoding', 'json');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.receive(ws, ev.data));
    // A failed connection fires 'error' and then 'close'; 'close' handles both.
    ws.addEventListener('close', (ev) => this.closed(ws, ev.code, ev.reason));
  }

  private receive(ws: WebSocket, data: unknown) {
    if (ws !== this.ws) return;
    let p: { op: number; d: any; s?: number | null; t?: string };
    try {
      p = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: // Hello: start heartbeating, then resume the session or identify.
        this.beat(ws, Number(p.d?.heartbeat_interval) || 41_250);
        this.sendOp(
          ws,
          this.sessionId
            ? { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } }
            : { op: 2, d: { token: this.token, intents: this.intents, properties: { os: process.platform, browser: 'bridge', device: 'bridge' } } },
        );
        break;
      case 11:
        this.acked = true;
        break;
      case 1:
        this.sendOp(ws, { op: 1, d: this.seq });
        break;
      case 7: // Reconnect requested: resume on a new connection.
        this.abandon(ws, 'reconnect requested');
        break;
      case 9: // Invalid session: d says whether it can be resumed. Discord asks for a pause before identifying again.
        if (!p.d) this.forget();
        this.attempt = Math.max(this.attempt, 1);
        this.abandon(ws, 'invalid session');
        break;
      case 0:
        this.dispatch(p.t ?? '', p.d);
        break;
    }
  }

  private dispatch(type: string, d: any) {
    switch (type) {
      case 'READY':
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.botId = String(d.user?.id ?? this.botId);
        this.appId = String(d.application?.id ?? '');
        this.attempt = 0;
        this.ready?.resolve();
        break;
      case 'RESUMED':
        this.attempt = 0;
        break;
      case 'MESSAGE_CREATE':
        this.enqueue(async () => {
          const msg = await this.parse(d);
          if (msg) this.onMessage(msg);
        }, 'message not read');
        break;
      case 'INTERACTION_CREATE':
        this.enqueue(() => this.interaction(d), 'button click not handled');
        break;
    }
  }

  private enqueue(fn: () => Promise<void>, what: string) {
    this.inbound = this.inbound.then(fn).catch((err) => console.error(`discord: ${what}: ${(err as Error).message}`));
  }

  /** Heartbeat every `interval` ms (the first after a random part of it); an unacknowledged beat means a dead connection. */
  private beat(ws: WebSocket, interval: number) {
    clearInterval(this.heartbeat);
    this.acked = true;
    const tick = () => {
      if (!this.acked) return this.abandon(ws, 'heartbeat not acknowledged');
      this.acked = false;
      this.sendOp(ws, { op: 1, d: this.seq });
    };
    this.heartbeat = setTimeout(() => {
      tick();
      if (this.ws === ws) this.heartbeat = setInterval(tick, interval);
    }, interval * Math.random());
  }

  private sendOp(ws: WebSocket, payload: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  /** We end this connection (dead or told to move): drop it without waiting for its close, and reconnect. */
  private abandon(ws: WebSocket, why: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    clearInterval(this.heartbeat);
    // Any code but 1000/1001 keeps the session resumable.
    ws.close(4000, why);
    if (!this.stopped) this.reconnect();
  }

  private closed(ws: WebSocket, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    clearInterval(this.heartbeat);
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      const err = new Error(`discord: ${fatal} (gateway close ${code}); not reconnecting`);
      console.error(err.message);
      this.stopped = true;
      this.ready?.reject(err);
      return;
    }
    if (FRESH_CLOSE.has(code)) this.forget();
    console.error(`discord: gateway connection closed (${code}${reason ? `: ${reason}` : ''}), reconnecting`);
    this.reconnect();
  }

  private forget() {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  /** Right away the first time, then backing off up to a minute until a session is ready again. */
  private reconnect() {
    const delay = this.attempt === 0 ? 0 : Math.min(60_000, 1000 * 2 ** (this.attempt - 1));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  // ---- Inbound ----

  private async parse(d: any): Promise<InboundMessage | undefined> {
    const author = d?.author;
    if (!author?.id || author.bot || author.id === this.botId) return undefined;
    if (d.type !== 0 && d.type !== 19) return undefined; // plain messages and replies; not joins, pins, thread notices…

    const mentions: any[] = d.mentions ?? [];
    const mentioned = mentions.some((u) => u?.id === this.botId) || d.referenced_message?.author?.id === this.botId;
    const names = new Map<string, string>(mentions.map((u) => [String(u.id), String(u.global_name ?? u.username ?? u.id)]));
    // The bot's own mention goes; everyone else's is spelled out.
    const text = String(d.content ?? '')
      .replace(/<@!?(\d+)>/g, (m, id: string) => (id === this.botId ? '' : names.has(id) ? `@${names.get(id)}` : m))
      .trim();
    const files: InboundFile[] = (d.attachments ?? []).map((a: any) => file(a));
    // Without the Message Content intent, messages that don't mention the bot arrive blank.
    if (!text && !files.length) return undefined;

    const isDM = !d.guild_id;
    let channelId = String(d.channel_id);
    let channelName = 'dm';
    let threadId = String(d.id);
    if (!isDM) {
      const info = await this.channel(channelId);
      if (info.parentId && THREAD_TYPES.has(info.type)) {
        remember(this.threads, channelId, Promise.resolve());
        threadId = channelId;
        channelId = info.parentId;
        channelName = (await this.channel(channelId)).name;
      } else {
        channelName = info.name;
        remember(this.threadNames, threadId, threadName(text, files));
      }
    }
    return {
      platform: 'discord',
      channelId,
      channelName,
      isDM,
      userId: String(author.id),
      userName: author.username,
      text,
      mentioned,
      threadId,
      messageId: String(d.id),
      files,
    };
  }

  private async interaction(d: any) {
    if (d?.type !== 3) return; // message component (button) clicks only
    const userId = String(d.member?.user?.id ?? d.user?.id ?? '');
    const channelId = String(d.channel_id ?? '');
    // Acknowledge at once (Discord allows 3 s); the message itself is edited once the choice settles.
    await this.rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 6 }, 'interaction reply').catch((err) =>
      console.error(`discord: acknowledging a button click failed: ${(err as Error).message}`),
    );
    if (!userId || !d.message?.id || typeof d.data?.custom_id !== 'string') return;
    remember(this.interactions, `${channelId}:${userId}`, { token: String(d.token), at: Date.now() });
    this.onAction?.({ platform: 'discord', channelId, userId, messageId: String(d.message.id), value: d.data.custom_id });
  }

  /** Channel type, name and parent, looked up once (a failed lookup is retried next time). */
  private channel(id: string): Promise<ChannelInfo> {
    let info = this.channels.get(id);
    if (!info) {
      info = this.rest<any>('GET', `/channels/${id}`).then((c) => ({
        type: Number(c.type),
        name: String(c.name ?? id),
        parentId: c.parent_id ? String(c.parent_id) : undefined,
      }));
      this.channels.set(id, info);
      info.catch(() => this.channels.delete(id));
    }
    return info;
  }

  // ---- REST ----

  /** One REST call; a rate limit (429) waits as Discord says and tries again. `what` names calls whose path holds a token. */
  private async rest<T = unknown>(method: string, path: string, body?: unknown, what = `${method} ${path}`): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          'user-agent': 'DiscordBot (bridge, 0.1)',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 204) return undefined as T;
      const json = (await res.json().catch(() => ({}))) as any;
      const wait = Number(json?.retry_after);
      if (res.status === 429 && attempt < 3 && wait >= 0 && wait <= 30) {
        await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000)));
        continue;
      }
      if (!res.ok) throw new DiscordError(what, res.status, json ?? {});
      return json as T;
    }
  }
}

function render(text: string): string {
  return truncateDiscord(toDiscordMarkdown(text), CONTENT_MAX);
}

/** A thread's name: the first line of the message that starts it (Discord allows 100 characters). */
function threadName(text: string, files: InboundFile[]): string {
  const line = text.split('\n')[0]!.trim() || files[0]?.name || 'Conversation';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Attachments are on Discord's CDN behind signed URLs: no token needed (or sent). */
function file(a: any): InboundFile {
  return {
    name: String(a.filename ?? a.id),
    mime: a.content_type,
    size: typeof a.size === 'number' ? a.size : undefined,
    download: async () => {
      const res = await fetch(String(a.url), { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KNOWN) map.delete(map.keys().next().value!);
}
