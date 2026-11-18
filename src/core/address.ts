import { createHash } from 'node:crypto';
/**
 * Endpoint addresses as written in bridge.yaml:
 *   slack:#dev      IM channel by name      telegram:*   any chat on that IM
 *   slack:dm        direct messages         local:*      the `bridge chat` console
 *   claude-code     an agent                github.push  tool `push` on tool server `github`
 */
export type Address =
  | { kind: 'im'; platform: string; channel: string }
  | { kind: 'agent'; name: string };

export const IM_PLATFORMS = new Set(['slack', 'telegram', 'feishu', 'local']);

export function parseAddress(s: string): Address {
  const i = s.indexOf(':');
  if (i > 0 && IM_PLATFORMS.has(s.slice(0, i))) {
    return { kind: 'im', platform: s.slice(0, i), channel: s.slice(i + 1) || '*' };
  }
  return { kind: 'agent', name: s };
}

/** Glob match where `*` matches any run of characters (including dots). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return re.test(value);
}

export function anyGlob(patterns: string | string[] | undefined, value: string): boolean {
  if (patterns === undefined) return false;
  return (Array.isArray(patterns) ? patterns : [patterns]).some((p) => globMatch(p, value));
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** The longest delay setTimeout honours; longer ones fire immediately. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** "90s", "10m", "2h", "1d" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 30s, 10m, 2h)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

/** The URL this machine reaches a server listening on `host:port` at (a wildcard host means loopback). */
export function localBaseUrl(server: { host: string; port: number }) {
  const host = ['0.0.0.0', '::', ''].includes(server.host) ? '127.0.0.1' : server.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${server.port}`;
}

/** The conversation key of a person's direct messages with the bot on one IM. */
export function dmKey(platform: string, userId: string): string {
  return `${platform}:dm:${userId}`;
}

export function isDmKey(key: string): boolean {
  return key.split(':')[1] === 'dm';
}

/** A conversation key as a short, readable, unique name (worktree folders and branches use it). */
export function sessionSlug(sessionKey: string): string {
  const readable = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  const hash = createHash('sha1').update(sessionKey).digest('hex').slice(0, 6);
  return `${readable}-${hash}`;
}
