import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bridge } from '../core/bridge.ts';
import type { ConfigGate } from '../config/gate.ts';
import { PAGE } from './page.ts';

/** What the dashboard serves: the running bridge, the config file's gate, and the person it acts as. */
export interface Dashboard {
  bridge: Bridge;
  /** Absent when no config file is watched (nothing to apply). */
  gate?: ConfigGate;
  /** The person the dashboard decides as: this machine's owner. Throws when there is none. */
  owner(): string;
}

/**
 * The local dashboard: GET / (page), /api/* (JSON), /oauth/* (sign-in).
 * Loopback only. Requests must name this host (no DNS rebinding), and writes must be same-origin JSON
 * (other sites can't send that without a CORS preflight, which this server never grants).
 */
export async function handleWeb(d: Dashboard, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const b = d.bridge;
  const path = url.pathname;
  const ours = path === '/' || path.startsWith('/api/') || path.startsWith('/oauth/');
  if (!ours) return false;

  if (!isLoopback(req.socket.remoteAddress)) return deny(res, 403, 'the dashboard is only served to this machine');
  const port = req.socket.localPort;
  const host = req.headers.host ?? '';
  if (!['127.0.0.1', 'localhost', '[::1]'].some((h) => host === `${h}:${port}`)) return deny(res, 403, 'unexpected Host header');

  if (path.startsWith('/oauth/')) return b.oauth.handle(req, res, url);

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return deny(res, 403, 'cross-origin request');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return deny(res, 415, 'send application/json');
  }

  try {
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      });
      res.end(PAGE);
      return true;
    }
    if (path === '/api/status' && req.method === 'GET') return json(res, 200, await b.status());
    const signIn = /^\/api\/oauth\/([\w.-]+)$/.exec(path);
    if (signIn && req.method === 'GET') {
      return json(res, 200, { status: b.oauth.status(signIn[1]!), last: b.oauth.lastResult(signIn[1]!) ?? null });
    }
    if (path === '/api/overview' && req.method === 'GET') {
      return json(res, 200, {
        status: await b.status(),
        sessions: await b.sessions(),
        choices: b.pendingChoices(),
        config: { pending: d.gate?.pending() ?? null },
      });
    }
    if (path === '/api/trace' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 2000);
      return json(res, 200, await b.auditTrail({ sessionKey: url.searchParams.get('session') ?? undefined, limit }));
    }
    if (path === '/api/tools' && req.method === 'GET') return json(res, 200, await b.toolServers());

    if (req.method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const choice = /^\/api\/choices\/([\w-]+)$/.exec(path);
      if (choice) {
        b.decide(choice[1]!, String(body.value ?? ''), d.owner(), 'web');
        return json(res, 200, { ok: true });
      }
      const ws = /^\/api\/sessions\/(merge|discard)$/.exec(path);
      if (ws) {
        const opts = { preview: body.preview === true, person: d.owner(), via: 'web' };
        return json(res, 200, { text: await b.branchAction(String(body.key ?? ''), ws[1] as 'merge' | 'discard', opts) });
      }
      const config = /^\/api\/config\/(apply|reject)$/.exec(path);
      if (config) {
        // `bridge check --apply` posts here too, as whoever runs it on this machine.
        if (!d.gate) throw new Error('this bridge does not watch a config file');
        const sha = String(body.sha ?? '');
        const by = `${d.owner()} (${body.via === 'cli' ? 'cli' : 'web'})`;
        if (config[1] === 'reject') {
          d.gate.reject(sha, by);
          return json(res, 200, { changes: [] });
        }
        return json(res, 200, { changes: d.gate.confirm(sha, by) });
      }
      if (path === '/api/oauth/sign-out') {
        b.oauth.signOut(String(body.server ?? ''));
        return json(res, 200, { ok: true });
      }
    }
    return deny(res, 404, 'not found');
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}

function isLoopback(addr: string | undefined) {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

function json(res: ServerResponse, status: number, v: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(v));
  return true;
}

function deny(res: ServerResponse, status: number, error: string) {
  return json(res, status, { error });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
