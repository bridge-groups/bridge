import type { InboundMessage } from '../../core/router.ts';

export interface OutboundMessage {
  channelId: string;
  /** Reply inside this thread (root message id). */
  threadId: string;
  isDM: boolean;
  text: string;
}

/** A button. `value` comes back in an InboundAction when someone clicks it. */
export interface Choice {
  label: string;
  value: string;
  style?: 'primary' | 'danger';
}

/** Someone clicked a button the bridge sent. */
export interface InboundAction {
  platform: string;
  channelId: string;
  userId: string;
  messageId: string;
  value: string;
}

/**
 * After a successful start, an adapter whose inbound connection can drop says so: `receiving: false` while it
 * reconnects (sending may still work), `receiving: true` once it receives again. `missedSince` is set when what was
 * sent from then on may never arrive (the platform could not replay it).
 */
export type LinkChange = { receiving: false; reason: string } | { receiving: true; missedSince?: number };

/** An IM connection. Every adapter connects outbound (socket / long-poll), so no public URL is needed. */
export interface ImAdapter {
  readonly platform: string;
  /**
   * Connect. When it rejects (a refused credential, no network) the adapter holds no connection, and the bridge
   * calls `start` again later with the same callbacks. `onLink` hears when receiving stops and resumes after that.
   */
  start(
    onMessage: (msg: InboundMessage) => void,
    onAction?: (action: InboundAction) => void,
    onLink?: (change: LinkChange) => void,
  ): Promise<void>;
  stop(): Promise<void>;
  /** Returns the platform message id. */
  send(msg: OutboundMessage): Promise<string>;
  /** Replace a message the bridge sent earlier. Adapters that cannot edit leave this out. */
  edit?(channelId: string, messageId: string, text: string): Promise<void>;
  /** Post a message with buttons. Adapters without buttons leave this out; the bridge falls back to typed replies. */
  sendChoice?(msg: OutboundMessage, choices: Choice[]): Promise<string>;
  /** Replace a choice message once decided: same text, buttons swapped for the outcome. */
  resolveChoice?(channelId: string, messageId: string, text: string, outcome: string): Promise<void>;
  /** Tell one person something only they see (e.g. "only alice can decide"). */
  notifyUser?(channelId: string, userId: string, text: string): Promise<void>;
  /** Longest text one message can carry; the bridge splits longer replies. */
  readonly maxTextLength: number;
  /**
   * Messages sent while the bridge was not running arrive once it starts (Telegram keeps them for a day). Adapters
   * whose platform drops them leave this out, and the owners are told after a restart to resend what got no answer.
   */
  readonly replaysMissed?: boolean;
}
