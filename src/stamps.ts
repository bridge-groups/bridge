import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';

/**
 * Start every line written to `stream` with an ISO-8601 time and a space, so a log file can be matched against a
 * timeline. Wrapping the stream's `write` catches everything: the bridge's own log, adapters writing to `console`, and
 * SDK loggers. A line written in several pieces is stamped once, when it starts. A terminal is left alone: the stamps
 * are for logs read later (the launchd service writes to a file).
 */
export function stampLines(stream: Pick<Writable, 'write'> & { isTTY?: boolean }, now: () => Date = () => new Date()): void {
  if (stream.isTTY) return;
  const write = stream.write.bind(stream) as (chunk: string, cb?: (err?: Error | null) => void) => boolean;
  // Buffers may split a multi-byte character; the decoder holds the partial bytes until the rest arrives.
  const decoder = new StringDecoder('utf8');
  let atLineStart = true;
  stream.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
    const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
    if (!text) return write('', callback);
    const stamp = `${now().toISOString()} `;
    let out = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (atLineStart) out += stamp;
      out += part;
      atLineStart = part.endsWith('\n');
    }
    return write(out, callback);
  }) as Writable['write'];
}
