import type { ImAdapter, OutboundMessage } from './types.ts';

/**
 * Stands in for an IM whose adapter could not be built (a credential that can't be read): every start fails with
 * the reason, so the bridge reports that IM as down while the others run.
 */
export class FailedIm implements ImAdapter {
  readonly platform: string;
  readonly maxTextLength = 1000;
  private readonly reason: string;

  constructor(platform: string, reason: string) {
    this.platform = platform;
    this.reason = reason;
  }

  async start(): Promise<void> {
    throw new Error(this.reason);
  }

  async stop() {}

  async send(_msg: OutboundMessage): Promise<string> {
    throw new Error(`${this.platform} is not connected: ${this.reason}`);
  }
}
