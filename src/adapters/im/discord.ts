import type { InboundFile, InboundMessage } from '../../core/router.ts';
import { toDiscordMarkdown, truncateDiscord } from './discord-format.ts';
import type { Choice, ImAdapter, InboundAction, LinkChange, OutboundMessage } from './types.ts';

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
/** A gateway connection that has not reached READY or RESUMED in this time is dropped and tried again. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** Posted once in a conversation thread where a message arrived blank (no Message Content intent). */
const BLANK_HINT =
  "I can't read messages in this thread unless they @mention me (this bot doesn't have Discord's Message Content intent). Mention me to continue, or ask whoever runs the bridge to turn the intent on.";
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
 * (Discord blanks the rest), so follow-ups in a thread must mention the bot too; the first blank message in a
 * conversation thread gets a hint saying so. A message that mentions the bot's role (it looks like the app in the @
 * list) is answered with a note to mention the app. Every ignored message is logged with why (ids only). The bot it
 * needs is described by `bridge discord setup`.
 *
 * The gateway reconnects on its own: a dead connection (no heartbeat ack), a close, or an attempt that has not
 * reached READY / RESUMED within the handshake timeout is dropped and retried with backoff, resuming the session
 * when Discord allows it. Every step is logged, and `onLink` hears when receiving stops and resumes, including when
 * a new session means events were lost.
 */
export class DiscordAdapter implements ImAdapter {
  readonly platform = 'discord';
  readonly maxTextLength = 1900;
  private readonly token: string;
  private readonly api: string;
  private readonly intents: number;
  private readonly messageContent: boolean;
  private readonly handshakeMs: number;
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
  /** Ends a connection attempt that has not reached READY or RESUMED in time. */
  private handshake?: ReturnType<typeof setTimeout>;
  /** What the current connection attempt is waiting for (the log names it when the attempt stalls). */
  private awaiting = '';
  /** Whether the current connection asked to resume a session. */
  private resuming = false;
  private attempt = 0;
  private stopped = false;
  /** Set while `start` waits for the first session. */
  private ready?: PromiseWithResolvers<void>;
  /** When the gateway last sent anything. */
  private lastEventAt = 0;
  /** During an outage after start: when the gateway last sent anything before it began. */
  private quietSince?: number;
  /** Set when the session was lost after start: events from then on were not replayed. */
  private missedSince?: number;
  /** Inbound events are handled one at a time, so messages reach the bridge in order. */
  private inbound: Promise<void> = Promise.resolve();
  private onMessage: (msg: InboundMessage) => void = () => {};
  private onAction?: (action: InboundAction) => void;
  private onLink?: (change: LinkChange) => void;

  private readonly channels = new Map<string, Promise<ChannelInfo>>();
  /** Threads known to exist (by id, which is their root message id), or being opened. */
  private readonly threads = new Map<string, Promise<void>>();
  /** Root message id → the name its thread gets. */
  private readonly threadNames = new Map<string, string>();
  /** Message the bot sent → the channel or thread it is in (edits address it there). */
  private readonly channelOf = new Map<string, string>();
  /** "channel:user" → the token of that person's last button click, for a reply only they see. */
  private readonly interactions = new Map<string, { token: string; at: number }>();
  /** Conversation threads already told that blank messages can't be read. */
  private readonly hinted = new Map<string, true>();
  /** Guild → the bot's managed role there (none if it has none). */
  private readonly botRoles = new Map<string, Promise<{ id: string; name: string } | undefined>>();

  constructor(opts: { botToken: string; messageContent?: boolean; apiBase?: string; handshakeTimeoutMs?: number }) {
    this.token = opts.botToken;
    this.api = opts.apiBase ?? 'https://discord.com/api/v10';
    this.messageContent = opts.messageContent ?? false;
    this.intents = DISCORD_INTENTS.guildMessages | DISCORD_INTENTS.directMessages | (this.messageContent ? DISCORD_INTENTS.messageContent : 0);
    this.handshakeMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * Resolves once the gateway session is ready. Rejects, holding no connection, when the first connection fails
   * (Discord refuses the token or intents, the connection closes or stalls); the bridge then tries again later.
   */
  async start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void, onLink?: (change: LinkChange) => void) {
    this.onMessage = onMessage;
    this.onAction = onAction;
    this.onLink = onLink;
    this.stopped = false;
    this.attempt = 0;
    this.forget();
    this.missedSince = this.quietSince = undefined;
    this.botId = (await this.rest<{ id: string }>('GET', '/users/@me')).id;
    this.gatewayUrl = (await this.rest<{ url: string }>('GET', '/gateway/bot')).url;
    const ready = Promise.withResolvers<void>();
    this.ready = ready;
    this.connect();
    try {
      await ready.promise;
    } catch (err) {
      this.ready = undefined;
      this.halt();
      throw err;
    }
  }

  async stop() {
    this.halt();
    this.ready?.reject(new Error('discord: stopped before the gateway was ready'));
    await this.inbound;
  }

  /** Close the gateway connection and reconnect no more. */
  private halt() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
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
    this.resuming = Boolean(this.sessionId && this.resumeUrl);
    const url = new URL(this.resuming ? this.resumeUrl! : this.gatewayUrl!);
    url.searchParams.set('v', '10');
    url.searchParams.set('encoding', 'json');
    const ws = new WebSocket(url);
    this.ws = ws;
    // A handshake stuck behind a proxy fires no 'close'; this timer ends it.
    this.awaiting = 'connection not open';
    clearTimeout(this.handshake);
    this.handshake = setTimeout(() => this.abandon(ws, `${this.awaiting} within ${seconds(this.handshakeMs)}`), this.handshakeMs);
    ws.addEventListener('open', () => {
      if (ws === this.ws) this.awaiting = 'no Hello';
    });
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
    this.lastEventAt = Date.now();
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: // Hello: start heartbeating, then resume the session or identify.
        this.awaiting = this.resuming ? 'no RESUMED' : 'no READY';
        this.beat(ws, Number(p.d?.heartbeat_interval) || 41_250);
        this.sendOp(
          ws,
          this.resuming
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
        this.abandon(ws, 'reconnect requested by Discord');
        break;
      case 9: {
        // Invalid session: d says whether it can be resumed. Discord asks for a pause before identifying again.
        const why = p.d ? 'session invalid (resumable)' : this.resuming ? 'resume refused' : 'session invalid';
        if (!p.d) this.loseSession();
        this.attempt = Math.max(this.attempt, 1);
        this.abandon(ws, why);
        break;
      }
      case 0:
        this.dispatch(p.t ?? '', p.d);
        break;
    }
  }

  private dispatch(type: string, d: any) {
    switch (type) {
      case 'READY': {
        clearTimeout(this.handshake);
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.botId = String(d.user?.id ?? this.botId);
        this.appId = String(d.application?.id ?? '');
        this.attempt = 0;
        const starting = this.ready;
        if (starting) {
          this.ready = undefined;
          console.log('discord: gateway session started');
          starting.resolve();
          break;
        }
        // A new session after start: Discord does not replay what the old one missed.
        const missedSince = this.missedSince ?? this.quietSince ?? this.lastEventAt;
        this.missedSince = this.quietSince = undefined;
        console.error(`discord: gateway session started afresh; events since ${new Date(missedSince).toISOString()} were not replayed`);
        this.onLink?.({ receiving: true, missedSince });
        break;
      }
      case 'RESUMED':
        clearTimeout(this.handshake);
        this.attempt = 0;
        this.quietSince = undefined;
        console.log('discord: gateway session resumed');
        this.onLink?.({ receiving: true });
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

  /** We end this connection (dead, stalled or told to move): drop it without waiting for its close, and reconnect. */
  private abandon(ws: WebSocket, why: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    // Any code but 1000/1001 keeps the session resumable.
    ws.close(4000);
    this.retry(why);
  }

  private closed(ws: WebSocket, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      const err = new Error(`discord: ${fatal} (gateway close ${code}); not reconnecting`);
      console.error(err.message);
      this.halt();
      if (this.ready) this.ready.reject(err);
      else this.onLink?.({ receiving: false, reason: `${fatal} (gateway close ${code}); not reconnecting until the bridge restarts` });
      return;
    }
    if (FRESH_CLOSE.has(code)) this.loseSession();
    this.retry(`connection closed (${code}${reason ? `: ${reason}` : ''})`);
  }

  /** The session cannot be resumed: the next connection identifies afresh, and what it missed is gone. */
  private loseSession() {
    if (this.sessionId && !this.ready) this.missedSince ??= this.quietSince ?? this.lastEventAt;
    this.forget();
  }

  private forget() {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  /**
   * The connection is gone. While starting, `start` fails with the reason (the bridge tries again later); after
   * that, reconnect right away the first time, then backing off up to a minute until a session is ready again.
   */
  private retry(why: string) {
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
    if (this.stopped) return;
    if (this.ready) {
      console.error(`discord: gateway ${why}`);
      this.ready.reject(new Error(`discord: gateway ${why}`));
      return;
    }
    this.quietSince ??= this.lastEventAt;
    const delay = this.attempt === 0 ? 0 : Math.min(60_000, 1000 * 2 ** (this.attempt - 1));
    this.attempt++;
    const next = this.sessionId ? 'resuming the session' : 'starting a new session';
    console.error(`discord: gateway ${why}; ${next} ${delay ? `in ${seconds(delay)}` : 'now'}`);
    this.onLink?.({ receiving: false, reason: `gateway ${why}` });
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  // ---- Inbound ----

  private async parse(d: any): Promise<InboundMessage | undefined> {
    const author = d?.author;
    // The bot's own messages come back for every reply: not worth a log line.
    if (!author?.id || author.id === this.botId) return undefined;
    if (author.bot) return this.ignore(d, 'sent by a bot');
    // Plain messages and replies; not joins, pins, thread notices…
    if (d.type !== 0 && d.type !== 19) return this.ignore(d, `message type ${d.type}`);

    const mentions: any[] = d.mentions ?? [];
    const mentioned = mentions.some((u) => u?.id === this.botId) || d.referenced_message?.author?.id === this.botId;
    const names = new Map<string, string>(mentions.map((u) => [String(u.id), String(u.global_name ?? u.username ?? u.id)]));
    // The bot's own mention goes; everyone else's is spelled out.
    const text = String(d.content ?? '')
      .replace(/<@!?(\d+)>/g, (m, id: string) => (id === this.botId ? '' : names.has(id) ? `@${names.get(id)}` : m))
      .trim();
    const files: InboundFile[] = (d.attachments ?? []).map((a: any) => file(a));
    // The bot's role looks like the app in Discord's @ list, but mentioning it is not mentioning the bot.
    const role = !mentioned && d.guild_id && d.mention_roles?.length ? await this.ownRole(String(d.guild_id), d.mention_roles) : undefined;
    if (role) await this.hintRole(d, role);
    // Without the Message Content intent, messages that don't mention the bot arrive blank.
    let unreadable: string | undefined;
    if (!text && !files.length) {
      if (role) return this.ignore(d, `mentions the ${role} role, not the app`);
      if (!this.messageContent && d.guild_id && !d.sticker_items?.length) {
        await this.hintBlank(String(d.channel_id));
        return this.ignore(d, 'blank: it does not mention the app, and the bot has no Message Content intent');
      }
      // A sticker, a poll…: the bridge tells the sender when it was meant for the bot.
      unreadable = d.sticker_items?.length ? 'stickers' : d.poll ? 'polls' : 'messages without text or files';
    }

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
      ...(unreadable ? { unreadable } : {}),
    };
  }

  /** Log a message that goes no further, and why (ids only: never what it says). */
  private ignore(d: any, why: string): undefined {
    console.log(`discord: ignored message ${d.id} in channel ${d.channel_id}: ${why}`);
    return undefined;
  }

  /** The name of the bot's own (managed) role if it is among `roleIds`; each guild's roles are looked up once. */
  private async ownRole(guildId: string, roleIds: unknown[]): Promise<string | undefined> {
    let role = this.botRoles.get(guildId);
    if (!role) {
      role = this.rest<any[]>('GET', `/guilds/${guildId}/roles`).then((roles) => {
        const own = roles.find((r) => r?.tags?.bot_id === this.botId);
        return own ? { id: String(own.id), name: String(own.name) } : undefined;
      });
      remember(this.botRoles, guildId, role);
      role.catch(() => this.botRoles.delete(guildId));
    }
    const own = await role;
    return own && roleIds.map(String).includes(own.id) ? own.name : undefined;
  }

  /** Answer a message that mentions the bot's role instead of the bot: it was meant for the bot, but is not read. */
  private async hintRole(d: any, role: string) {
    const content = `You mentioned the @${role} role, not the app, so I didn't read this. Mention the app instead: in the @ list, pick the entry marked APP.`;
    await this.post(String(d.channel_id), { content, message_reference: { message_id: String(d.id), fail_if_not_exists: false } }).catch((err) =>
      console.error(`discord: hint about a role mention not sent: ${(err as Error).message}`),
    );
  }

  /** In a thread the bot takes part in, say once why a blank message got no answer. */
  private async hintBlank(threadId: string) {
    if (!this.threads.has(threadId) || this.hinted.has(threadId)) return;
    remember(this.hinted, threadId, true);
    await this.post(threadId, { content: BLANK_HINT }).catch((err) =>
      console.error(`discord: hint about unreadable messages not sent: ${(err as Error).message}`),
    );
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

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
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
