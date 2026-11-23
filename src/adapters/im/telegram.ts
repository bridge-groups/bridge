import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InboundFile, InboundMessage } from '../../core/router.ts';
import type { Choice, ImAdapter, InboundAction, OutboundMessage } from './types.ts';
import { plain } from './markdown.ts';
import { toTelegramHtml } from './telegram-format.ts';

/** How many message → thread-root entries are kept (and persisted): recent threads, a small file. */
const MAX_ROOTS = 5000;
/** Any call but the long poll. */
const CALL_TIMEOUT_MS = 60_000;
/** Telegram's limits: message text, and a button's callback_data in bytes. */
const TEXT_MAX = 4096;
const DATA_MAX = 64;
/** The Bot API hands bots files up to this size. */
const DOWNLOAD_MAX = 20 * 1024 * 1024;
const UPDATES = ['message', 'callback_query'];

interface TelegramState {
  /** The next update id to fetch: everything below it was handed to the bridge. */
  offset: number;
  /** "chatId:messageId" → thread root message id, oldest first. */
  roots: [string, string][];
}

/**
 * Telegram via Bot API long polling (no public URL). With privacy mode on (BotFather's default) a bot in a group
 * gets only commands for it and replies to it, not messages that @-mention it, so group routes need it off
 * (`/setprivacy` → Disable, then add the bot to the group again); start() logs a warning while it is on.
 * A reply chain to one root message is one thread. Choices are inline-keyboard buttons; attachments (files, photos,
 * audio, video, GIFs) are fetched through getFile.
 *
 * With `stateFile`, the update offset and the reply-chain map survive restarts, so the last batch
 * isn't delivered twice and threads don't split. Without it the offset is still confirmed to
 * Telegram on stop().
 */
export class TelegramAdapter implements ImAdapter {
  readonly platform = 'telegram';
  readonly maxTextLength = 4000;
  /** Telegram keeps unconfirmed updates for a day. */
  readonly replaysMissed = true;
  private readonly api: string;
  private readonly fileApi: string;
  private readonly stateFile?: string;
  private username = '';
  private botId = 0;
  private offset = 0;
  /** Cancels only the long poll; sends and edits in flight finish on their own. */
  private readonly polling = new AbortController();
  private pollLoop?: Promise<void>;
  private readonly rootOf = new Map<string, string>();
  /** "chatId:userId" → the button click being handled, until it is answered. */
  private readonly clicks = new Map<string, string>();

  constructor(opts: { botToken: string; apiBase?: string; stateFile?: string }) {
    const base = opts.apiBase ?? 'https://api.telegram.org';
    this.api = `${base}/bot${opts.botToken}`;
    this.fileApi = `${base}/file/bot${opts.botToken}`;
    this.stateFile = opts.stateFile;
    this.load();
  }

  async start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void) {
    const me = await this.call<{ id: number; username: string; can_read_all_group_messages?: boolean }>('getMe', {});
    this.botId = me.id;
    this.username = me.username;
    if (me.can_read_all_group_messages === false) {
      console.error(
        `telegram: privacy mode is on, so in groups @${me.username} gets only commands and replies to it, not messages that mention it. ` +
          'Turn it off in @BotFather (/setprivacy → Disable), then remove the bot from each group and add it again.',
      );
    }
    this.pollLoop = this.poll(onMessage, onAction);
  }

  async stop() {
    this.polling.abort();
    await this.pollLoop;
    // Confirm what was handed over, so Telegram doesn't deliver it again after a restart.
    if (this.offset) {
      await this.call('getUpdates', { offset: this.offset, timeout: 0, limit: 1, allowed_updates: UPDATES }, AbortSignal.timeout(10_000)).catch(
        (err) => console.error(`telegram: confirming updates failed: ${(err as Error).message}`),
      );
    }
    this.save();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const sent = await this.formatted<{ message_id: number }>('sendMessage', msg.text, {
      chat_id: msg.channelId,
      ...(msg.isDM ? {} : { reply_parameters: { message_id: Number(msg.threadId), allow_sending_without_reply: true } }),
    });
    const id = String(sent.message_id);
    this.remember(msg.channelId, id, msg.threadId);
    this.save();
    return id;
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.formatted('editMessageText', text, { chat_id: channelId, message_id: Number(messageId) });
  }

  async sendChoice(msg: OutboundMessage, choices: Choice[]): Promise<string> {
    for (const c of choices) {
      if (Buffer.byteLength(c.value) > DATA_MAX) throw new Error(`telegram: button value longer than ${DATA_MAX} bytes: ${c.value.slice(0, 20)}…`);
    }
    const sent = await this.formatted<{ message_id: number }>('sendMessage', msg.text, {
      chat_id: msg.channelId,
      reply_markup: { inline_keyboard: [choices.map((c) => ({ text: c.label, callback_data: c.value }))] },
      ...(msg.isDM ? {} : { reply_parameters: { message_id: Number(msg.threadId), allow_sending_without_reply: true } }),
    });
    const id = String(sent.message_id);
    this.remember(msg.channelId, id, msg.threadId);
    this.save();
    return id;
  }

  /** Same text with the outcome below it; editing without reply_markup removes the buttons. */
  async resolveChoice(channelId: string, messageId: string, text: string, outcome: string) {
    const body = text.length + outcome.length + 1 > TEXT_MAX ? `${text.slice(0, TEXT_MAX - outcome.length - 2)}…` : text;
    await this.formatted('editMessageText', `${body}\n${outcome}`, { chat_id: channelId, message_id: Number(messageId) });
  }

  /**
   * Said while the bridge handles that person's click: an alert only they see. Otherwise (the click was already
   * answered) a message in the chat, since Telegram has no message that one group member alone sees.
   */
  async notifyUser(channelId: string, userId: string, text: string) {
    const key = `${channelId}:${userId}`;
    const click = this.clicks.get(key);
    if (click) {
      this.clicks.delete(key);
      await this.call('answerCallbackQuery', { callback_query_id: click, text: plain(text).slice(0, 200), show_alert: true });
      return;
    }
    await this.formatted('sendMessage', text, { chat_id: channelId });
  }

  private async poll(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void) {
    const signal = this.polling.signal;
    while (!signal.aborted) {
      try {
        const updates = await this.call<any[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: UPDATES },
          AbortSignal.any([signal, AbortSignal.timeout(30_000 + CALL_TIMEOUT_MS)]),
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            this.click(u.callback_query, onAction);
            continue;
          }
          const m = u.message;
          if (!m?.from || m.from.is_bot) continue;
          const parsed = this.parse(m);
          if (parsed) onMessage(parsed);
        }
        if (updates.length) this.save();
      } catch (err) {
        if (signal.aborted) return;
        console.error(`telegram poll: ${(err as Error).message}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    }
  }

  /**
   * A button click. The bridge may call notifyUser while handling it; whatever it doesn't answer is answered empty,
   * so the button stops spinning.
   */
  private click(q: any, onAction?: (action: InboundAction) => void) {
    const chatId = q.message?.chat?.id;
    const key = `${chatId}:${q.from.id}`;
    if (onAction && chatId !== undefined && typeof q.data === 'string') {
      this.clicks.set(key, q.id);
      onAction({ platform: 'telegram', channelId: String(chatId), userId: String(q.from.id), messageId: String(q.message.message_id), value: q.data });
      if (this.clicks.get(key) !== q.id) return; // notifyUser answered it
      this.clicks.delete(key);
    }
    this.call('answerCallbackQuery', { callback_query_id: q.id }).catch((err) =>
      console.error(`telegram: answering a button click failed: ${(err as Error).message}`),
    );
  }

  private parse(m: any): InboundMessage | undefined {
    const raw: string = m.text ?? m.caption ?? '';
    const files = this.files(m);
    // Nothing to pass on: the bridge tells the sender when it was meant for the bot.
    const kind = raw || files.length ? undefined : UNREADABLE.find(([field]) => m[field] !== undefined);
    if (!raw && !files.length && !kind) return undefined; // service messages: joins, pins, title changes…
    const chatId = String(m.chat.id);
    const isDM = m.chat.type === 'private';
    const tag = `@${this.username}`;
    const repliesToBot = m.reply_to_message?.from?.id === this.botId;
    const replyTo = m.reply_to_message ? String(m.reply_to_message.message_id) : undefined;
    const messageId = String(m.message_id);
    const threadId = replyTo ? (this.rootOf.get(`${chatId}:${replyTo}`) ?? replyTo) : messageId;
    this.remember(chatId, messageId, threadId);
    return {
      platform: 'telegram',
      channelId: chatId,
      channelName: isDM ? 'dm' : String(m.chat.title ?? m.chat.username ?? chatId),
      isDM,
      userId: String(m.from.id),
      userName: m.from.username,
      text: raw.split(tag).join('').trim(),
      mentioned: raw.includes(tag) || repliesToBot,
      threadId,
      messageId,
      ...(files.length ? { files } : {}),
      ...(kind ? { unreadable: kind[1] } : {}),
    };
  }

  /** A message carries at most one attachment; a photo comes in several sizes, the largest last. */
  private files(m: any): InboundFile[] {
    const id = m.message_id;
    const photo = Array.isArray(m.photo) ? m.photo.at(-1) : undefined;
    if (photo) return [this.file(photo, `photo-${id}.jpg`, 'image/jpeg')];
    for (const [field, fallback] of ATTACHMENTS) {
      const f = m[field];
      if (f?.file_id) return [this.file(f, f.file_name ?? `${fallback}-${id}${extension(f.mime_type)}`, f.mime_type)];
    }
    return [];
  }

  /** The download URL holds the bot token, so errors name the step, never the URL. */
  private file(f: any, name: string, mime?: string): InboundFile {
    const size = typeof f.file_size === 'number' ? f.file_size : undefined;
    return {
      name,
      mime,
      size,
      download: async () => {
        if (size !== undefined && size > DOWNLOAD_MAX) throw new Error('Telegram lets bots download files up to 20 MB');
        const { file_path } = await this.call<{ file_path?: string }>('getFile', { file_id: f.file_id });
        if (!file_path) throw new Error('Telegram gave no download path');
        const res = await fetch(`${this.fileApi}/${file_path}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }).catch(() => {
          throw new Error('download failed');
        });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  private remember(chatId: string, messageId: string, root: string) {
    this.rootOf.set(`${chatId}:${messageId}`, root);
    if (this.rootOf.size > MAX_ROOTS) this.rootOf.delete(this.rootOf.keys().next().value!);
  }

  private load() {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<TelegramState>;
      if (typeof state.offset === 'number') this.offset = state.offset;
      for (const [k, v] of state.roots ?? []) if (typeof k === 'string' && typeof v === 'string') this.rootOf.set(k, v);
    } catch (err) {
      console.error(`telegram: ignoring unreadable ${this.stateFile}: ${(err as Error).message}`);
    }
  }

  /** Atomic write (temp file + rename), so a crash mid-write leaves the previous state. */
  private save() {
    if (!this.stateFile) return;
    const state: TelegramState = { offset: this.offset, roots: [...this.rootOf] };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error(`telegram: saving ${this.stateFile} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Send or edit with Markdown rendered as Telegram HTML. Should Telegram refuse the HTML (an entity it can't
   * parse, or a table grid that grew past the length limit), the same text goes out as it was written.
   */
  private async formatted<T>(method: string, markdown: string, params: object): Promise<T> {
    try {
      return await this.call<T>(method, { ...params, text: toTelegramHtml(markdown), parse_mode: 'HTML' });
    } catch (err) {
      if (!/can't parse entities|too long/i.test((err as Error).message)) throw err;
      console.error(`telegram: sent as plain text, the HTML was refused: ${(err as Error).message}`);
      return await this.call<T>(method, { ...params, text: markdown.slice(0, TEXT_MAX) });
    }
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
    return json.result;
  }
}

/** Message fields passed on as files (besides photo), and the name stem for one that has no file name. */
const ATTACHMENTS: [string, string][] = [
  ['document', 'file'],
  ['audio', 'audio'],
  ['video', 'video'],
  ['animation', 'animation'],
];

function extension(mime?: string): string {
  const sub = mime?.split('/')[1]?.replace(/[^\w]/g, '');
  return sub ? `.${sub}` : '';
}

/** Message fields that carry content the adapter does not read, and how the sender is told about it. */
const UNREADABLE: [string, string][] = [
  ['sticker', 'stickers'],
  ['voice', 'voice messages'],
  ['video_note', 'video messages'],
  ['location', 'locations'],
  ['contact', 'contacts'],
  ['poll', 'polls'],
];
