import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DiscordAdapter } from '../adapters/im/discord.ts';
import type { InboundAction } from '../adapters/im/types.ts';
import type { InboundMessage } from '../core/router.ts';
import { until } from './helpers.ts';

/** One WebSocket connection on the fake gateway: just enough of RFC 6455 for unfragmented text frames. */
class Conn {
  closed = false;
  private readonly socket: Socket;
  constructor(socket: Socket, onText: (conn: Conn, text: string) => void) {
    this.socket = socket;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const mask = buf[1]! & 0x80 ? buf.subarray(off, off + 4) : undefined;
        if (mask) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        buf = buf.subarray(off + len);
        if (op === 1) onText(this, payload.toString());
        else if (op === 8) this.end(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
      }
    });
    socket.on('close', () => (this.closed = true));
    socket.on('error', () => {});
  }

  send(obj: object) {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(obj));
    const head =
      body.length < 126
        ? Buffer.from([0x81, body.length])
        : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([body.length >> 8, body.length & 0xff])]);
    this.socket.write(Buffer.concat([head, body]));
  }

  /** Close with a code (Discord's way of saying why). */
  end(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.socket.end(Buffer.from([0x88, 2, code >> 8, code & 0xff]));
  }

  /** Vanish without a close frame (a dead connection). */
  destroy() {
    this.closed = true;
    this.socket.destroy();
  }
}

interface Call {
  method: string;
  path: string;
  body: any;
}

/** A local Discord: REST under /api, the gateway on the same port, a CDN file under /cdn. */
async function fakeDiscord() {
  const calls: Call[] = [];
  const identifies: any[] = [];
  const resumes: any[] = [];
  const conns: Conn[] = [];
  const sockets = new Set<Socket>();
  const channels: Record<string, { type: number; name: string; parent_id?: string }> = {
    '10': { type: 0, name: 'general' },
  };
  const threads = new Set<string>();
  const state = { heartbeatInterval: 45_000, ackBeats: true, beats: 0, seq: 0, rateLimits: 0, closeOnIdentify: 0, threadError: 0 };
  let nextId = 5000;

  const onText = (conn: Conn, text: string) => {
    const p = JSON.parse(text);
    if (p.op === 2) {
      identifies.push(p.d);
      if (state.closeOnIdentify) return conn.end(state.closeOnIdentify);
      conn.send({ op: 0, t: 'READY', s: ++state.seq, d: { session_id: 'sess', resume_gateway_url: gateway, user: { id: '99' }, application: { id: 'app' } } });
    } else if (p.op === 6) {
      resumes.push(p.d);
      conn.send({ op: 0, t: 'RESUMED', s: ++state.seq, d: {} });
    } else if (p.op === 1) {
      state.beats++;
      if (state.ackBeats) conn.send({ op: 11 });
    }
  };

  const json = (res: any, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = req.url!;
      if (path === '/cdn/log.txt') return res.end('hello');
      if (!path.startsWith('/api/')) return json(res, 404, {});
      const call = { method: req.method!, path: path.slice(4), body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      assert.equal(req.headers.authorization, 'Bot T');
      let m: RegExpExecArray | null;
      if (call.path === '/users/@me') return json(res, 200, { id: '99' });
      if (call.path === '/gateway/bot') return json(res, 200, { url: gateway });
      if ((m = /^\/channels\/(\d+)$/.exec(call.path))) {
        const c = channels[m[1]!];
        return c ? json(res, 200, { id: m[1], ...c }) : json(res, 404, { message: 'Unknown Channel', code: 10003 });
      }
      if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(call.path))) {
        if (state.threadError) return json(res, 403, { message: 'Missing Permissions', code: state.threadError });
        if (threads.has(m[2]!)) return json(res, 400, { message: 'A thread has already been created for this message', code: 160004 });
        threads.add(m[2]!);
        channels[m[2]!] = { type: 11, name: call.body.name, parent_id: m[1] };
        return json(res, 201, { id: m[2] });
      }
      if (req.method === 'POST' && /^\/channels\/\d+\/messages$/.test(call.path)) {
        if (state.rateLimits > 0) {
          state.rateLimits--;
          return json(res, 429, { message: 'You are being rate limited.', retry_after: 0.01, global: false });
        }
        return json(res, 200, { id: String(nextId++) });
      }
      if (req.method === 'PATCH' && (m = /^\/channels\/\d+\/messages\/(\d+)$/.exec(call.path))) return json(res, 200, { id: m[1] });
      if (call.path.startsWith('/interactions/')) return json(res, 204);
      if (call.path.startsWith('/webhooks/')) return json(res, 200, { id: String(nextId++) });
      json(res, 404, { message: 'Unknown route' });
    });
  });
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Conn(socket, onText);
    conns.push(conn);
    conn.send({ op: 10, d: { heartbeat_interval: state.heartbeatInterval } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const gateway = `ws://127.0.0.1:${port}`;
  const base = `http://127.0.0.1:${port}`;
  const current = () => conns.at(-1)!;
  return {
    apiBase: `${base}/api`,
    base,
    calls,
    identifies,
    resumes,
    conns,
    channels,
    threads,
    state,
    current,
    dispatch(t: string, d: object) {
      current().send({ op: 0, t, s: ++state.seq, d });
    },
    /** REST calls other than the lookups. */
    writes: () => calls.filter((c) => c.method !== 'GET'),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const alice = { id: '1', username: 'alice' };
const inChannel = (id: string, content: string, extra: object = {}) => ({
  id,
  channel_id: '10',
  guild_id: 'g',
  type: 0,
  author: alice,
  content,
  mentions: [],
  attachments: [],
  ...extra,
});

test('discord: a conversation is a thread opened from its first message; follow-ups, edits and DMs', async () => {
  const dc = await fakeDiscord();
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  try {
    const got: InboundMessage[] = [];
    await a.start((m) => got.push(m));
    assert.equal(dc.identifies[0].intents, (1 << 9) | (1 << 12), 'no privileged intent unless asked');
    assert.equal(dc.identifies[0].token, 'T');

    dc.dispatch(
      'MESSAGE_CREATE',
      inChannel('1000', '<@99> fix the build\nplease ask <@2>', {
        mentions: [{ id: '99', username: 'bot' }, { id: '2', username: 'bob', global_name: 'Bob' }],
        attachments: [{ id: 'a1', filename: 'log.txt', size: 5, url: `${dc.base}/cdn/log.txt`, content_type: 'text/plain' }],
      }),
    );
    await until(() => got.length === 1, 'the first message');
    const first = got[0]!;
    assert.deepEqual(
      { ...first, files: undefined },
      {
        platform: 'discord',
        channelId: '10',
        channelName: 'general',
        isDM: false,
        userId: '1',
        userName: 'alice',
        text: 'fix the build\nplease ask @Bob',
        mentioned: true,
        threadId: '1000',
        messageId: '1000',
        files: undefined,
      },
    );
    assert.equal((await first.files![0]!.download()).toString(), 'hello');

    const reply = await a.send({ channelId: '10', threadId: '1000', isDM: false, text: '| a | b |\n|---|---|\n| 1 | 2 |' });
    await a.send({ channelId: '10', threadId: '1000', isDM: false, text: 'more' });
    const writes = dc.writes();
    assert.deepEqual(writes[0], { method: 'POST', path: '/channels/10/messages/1000/threads', body: { name: 'fix the build' } });
    assert.equal(writes.filter((c) => c.path.endsWith('/threads')).length, 1, 'the thread is opened once');
    assert.equal(writes[1]!.path, '/channels/1000/messages', 'replies go into the thread');
    assert.equal(writes[1]!.body.content, '```\na  b\n─  ─\n1  2\n```');
    assert.deepEqual(writes[1]!.body.allowed_mentions, { parse: [] }, 'agents never ping anyone');

    await a.edit('10', reply, 'done');
    assert.deepEqual(dc.writes().at(-1), {
      method: 'PATCH',
      path: `/channels/1000/messages/${reply}`,
      body: { content: 'done', allowed_mentions: { parse: [] } },
    });

    // Ignored: other bots, the bot itself, and messages blanked for lack of the Message Content intent.
    dc.dispatch('MESSAGE_CREATE', inChannel('1001', 'beep', { author: { id: '7', username: 'other', bot: true } }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1002', 'me', { author: { id: '99', username: 'bot' } }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1003', ''));
    // A reply to the bot inside the thread: same conversation, and it counts as a mention.
    dc.dispatch(
      'MESSAGE_CREATE',
      inChannel('1004', 'and the tests', { channel_id: '1000', type: 19, referenced_message: { author: { id: '99' } } }),
    );
    await until(() => got.length === 2, 'the follow-up');
    assert.deepEqual(
      [got[1]!.channelId, got[1]!.channelName, got[1]!.threadId, got[1]!.messageId, got[1]!.mentioned],
      ['10', 'general', '1000', '1004', true],
    );

    dc.dispatch('MESSAGE_CREATE', { id: '2000', channel_id: '50', type: 0, author: alice, content: 'hi', mentions: [], attachments: [] });
    await until(() => got.length === 3, 'the DM');
    assert.deepEqual([got[2]!.isDM, got[2]!.channelName, got[2]!.threadId, got[2]!.mentioned], [true, 'dm', '2000', false]);
    const before = dc.writes().length;
    await a.send({ channelId: '50', threadId: '2000', isDM: true, text: 'hello' });
    assert.deepEqual(dc.writes().slice(before).map((c) => c.path), ['/channels/50/messages'], 'DMs get no thread');
  } finally {
    await a.stop();
    await dc.close();
  }
});

test('discord: buttons for choices, clicks acknowledged, a private note to the clicker, the outcome replaces them', async () => {
  const dc = await fakeDiscord();
  dc.threads.add('1000'); // opened before a restart: the adapter finds it rather than failing
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  try {
    const actions: InboundAction[] = [];
    await a.start(() => {}, (x) => actions.push(x));
    const id = await a.sendChoice({ channelId: '10', threadId: '1000', isDM: false, text: 'Run `rm`?' }, [
      { label: 'Approve', value: 'c1|yes', style: 'primary' },
      { label: 'Deny', value: 'c1|no', style: 'danger' },
    ]);
    const posted = dc.writes().at(-1)!;
    assert.equal(posted.path, '/channels/1000/messages');
    assert.deepEqual(posted.body.components, [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Approve', custom_id: 'c1|yes' },
          { type: 2, style: 4, label: 'Deny', custom_id: 'c1|no' },
        ],
      },
    ]);

    dc.dispatch('INTERACTION_CREATE', {
      id: 'i1',
      token: 'itok',
      type: 3,
      channel_id: '1000',
      member: { user: { id: '1' } },
      message: { id },
      data: { custom_id: 'c1|yes' },
    });
    await until(() => actions.length === 1, 'the click');
    assert.deepEqual(actions[0], { platform: 'discord', channelId: '1000', userId: '1', messageId: id, value: 'c1|yes' });
    assert.ok(dc.calls.some((c) => c.path === '/interactions/i1/itok/callback' && c.body.type === 6), 'acknowledged');

    await a.notifyUser('1000', '1', 'Only bob can decide this.');
    assert.deepEqual(dc.writes().at(-1), {
      method: 'POST',
      path: '/webhooks/app/itok',
      body: { content: 'Only bob can decide this.', flags: 64, allowed_mentions: { parse: [] } },
    });

    await a.resolveChoice('10', id, 'Run `rm`?', '✅ Approved by alice');
    assert.deepEqual(dc.writes().at(-1), {
      method: 'PATCH',
      path: `/channels/1000/messages/${id}`,
      body: { content: 'Run `rm`?\n-# ✅ Approved by alice', components: [], allowed_mentions: { parse: [] } },
    });

    const many = Array.from({ length: 7 }, (_, i) => ({ label: `o${i}`, value: `c2|${i}` }));
    await a.sendChoice({ channelId: '10', threadId: '1000', isDM: false, text: 'Pick' }, many);
    assert.deepEqual(dc.writes().at(-1)!.body.components.map((r: any) => r.components.length), [5, 2]);
  } finally {
    await a.stop();
    await dc.close();
  }
});

test('discord: the gateway resumes after a reconnect request or a dead connection, and starts afresh when told to', async () => {
  const dc = await fakeDiscord();
  dc.state.heartbeatInterval = 30;
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  try {
    const got: InboundMessage[] = [];
    await a.start((m) => got.push(m));
    await until(() => dc.state.beats >= 2, 'heartbeats');
    dc.dispatch('MESSAGE_CREATE', inChannel('1000', '<@99> one'));
    await until(() => got.length === 1, 'a message');
    const seq = dc.state.seq;

    dc.current().send({ op: 7, d: null });
    await until(() => dc.resumes.length === 1, 'a resume after op 7');
    assert.deepEqual(dc.resumes[0], { token: 'T', session_id: 'sess', seq });
    dc.dispatch('MESSAGE_CREATE', inChannel('1001', '<@99> two'));
    await until(() => got.length === 2, 'a message on the resumed session');

    // Heartbeats stop being acknowledged: the connection is dead, so it is dropped and resumed.
    dc.state.ackBeats = false;
    await until(() => dc.resumes.length === 2, 'a resume after a missed heartbeat ack');
    dc.state.ackBeats = true;

    // A session that cannot be resumed: identify again (after Discord's requested pause).
    dc.current().send({ op: 9, d: false });
    await until(() => dc.identifies.length === 2, 'a fresh identify after op 9', 15_000);
    assert.equal(dc.resumes.length, 2);

    // Closed by the server for a reason that keeps the session: resume.
    dc.current().end(4000);
    await until(() => dc.resumes.length === 3, 'a resume after close 4000');
    // Closed with "session timed out": identify.
    dc.current().end(4009);
    await until(() => dc.identifies.length === 3, 'a fresh identify after close 4009');
  } finally {
    await a.stop();
    await dc.close();
  }
});

test('discord: a refused intent fails start with what to do; rate limits are waited out; a thread that cannot open is an error', async () => {
  const dc = await fakeDiscord();
  try {
    dc.state.closeOnIdentify = 4014;
    const refused = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase, messageContent: true });
    await assert.rejects(refused.start(() => {}), /Message Content intent is not enabled/);
    assert.equal(dc.identifies[0].intents, (1 << 9) | (1 << 12) | (1 << 15));
    await refused.stop();
    assert.equal(dc.identifies.length, 1, 'no reconnect after a fatal close');

    dc.state.closeOnIdentify = 0;
    const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
    await a.start(() => {});
    try {
      dc.state.rateLimits = 1;
      assert.ok(await a.send({ channelId: '50', threadId: '1', isDM: true, text: 'hi' }));
      assert.equal(dc.calls.filter((c) => c.path === '/channels/50/messages').length, 2, 'retried once after the 429');

      dc.state.threadError = 50013;
      await assert.rejects(a.send({ channelId: '10', threadId: '3000', isDM: false, text: 'x' }), /Create Public Threads/);
      dc.state.threadError = 0;
      await a.send({ channelId: '10', threadId: '3000', isDM: false, text: 'x' });
      assert.equal(dc.calls.filter((c) => c.path === '/channels/10/messages/3000/threads').length, 2, 'a failed open is retried');
    } finally {
      await a.stop();
    }
  } finally {
    await dc.close();
  }
});
