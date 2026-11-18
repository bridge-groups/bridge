import type { OAuthStorage, StoredAuth } from './mcp/oauth.ts';
import { deleteSecret, readSecret, setSecret } from './secrets.ts';

/**
 * Keychain-backed storage with an in-memory copy: the SDK asks for tokens on every request, and
 * reading the keychain spawns a process. Writes go through to the keychain immediately.
 */
export function keychainStorage(): OAuthStorage {
  const cache = new Map<string, StoredAuth>();
  const load = (server: string): StoredAuth => {
    const hit = cache.get(server);
    if (hit) return hit;
    const raw = readSecret(`oauth.${server}`);
    let value: StoredAuth = {};
    if (raw) {
      try {
        value = JSON.parse(raw) as StoredAuth;
      } catch {
        throw new Error(`the stored sign-in for "${server}" is unreadable — run: bridge auth ${server} --sign-out, then sign in again`);
      }
    }
    cache.set(server, value);
    return value;
  };
  return {
    get: (server) => structuredClone(load(server)),
    set(server, value) {
      setSecret(`oauth.${server}`, JSON.stringify(value));
        cache.set(server, structuredClone(value));
    },
    delete(server) {
      deleteSecret(`oauth.${server}`);
      cache.delete(server);
    },
  };
}

