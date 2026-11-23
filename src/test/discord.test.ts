import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { DiscordAdapter } from '../adapters/im/discord.ts';
import type { InboundAction, LinkChange } from '../adapters/im/types.ts';
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
  const state = {
    heartbeatInterval: 45_000,
    ackBeats: true,
    beats: 0,
    seq: 0,
    rateLimits: 0,
    closeOnIdentify: 0,
    threadError: 0,
    /** How the gateway answers a connection: normally, not at all (TCP open, no handshake), or without Hello. */
    upgrade: 'ok' as 'ok' | 'hang' | 'silent',
    /** Answer every RESUME with "invalid session, not resumable". */
    refuseResume: false,
  };
  /** Sockets the gateway accepted but never answered. */
  const hung: Socket[] = [];
  let nextId = 5000;

  const onText = (conn: Conn, text: string) => {
    const p = JSON.parse(text);
    if (p.op === 2) {
      identifies.push(p.d);
      if (state.closeOnIdentify) return conn.end(state.closeOnIdentify);
      conn.send({ op: 0, t: 'READY', s: ++state.seq, d: { session_id: 'sess', resume_gateway_url: gateway, user: { id: '99' }, application: { id: 'app' } } });
    } else if (p.op === 6) {
      resumes.push(p.d);
      if (state.refuseResume) return conn.send({ op: 9, d: false });
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
      if (call.path === '/guilds/g/roles') {
        return json(res, 200, [
          { id: 'g', name: '@everyone' },
          { id: 'r-bot', name: 'Bridge', managed: true, tags: { bot_id: '99' } },
          { id: 'r-mods', name: 'mods' },
        ]);
      }
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
    socket.on('error', () => {});
    if (state.upgrade === 'hang') {
      // Read (and ignore) what arrives, and close when the client does (upgraded sockets are half-open).
      socket.resume();
      socket.on('end', () => socket.destroy());
      return void hung.push(socket);
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Conn(socket, onText);
    conns.push(conn);
    if (state.upgrade === 'ok') conn.send({ op: 10, d: { heartbeat_interval: state.heartbeatInterval } });
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
    hung,
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

test('discord: a gateway that never completes the handshake or never says Hello fails start, and is let go', async () => {
  const dc = await fakeDiscord();
  try {
    dc.state.upgrade = 'hang';
    const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase, handshakeTimeoutMs: 100 });
    await assert.rejects(a.start(() => {}), /discord: gateway connection not open within 0\.1 s/);
    await until(() => dc.hung.length === 1 && dc.hung[0]!.destroyed, 'the stalled socket to be closed');

    dc.state.upgrade = 'silent';
    // The same adapter can start again (the bridge retries it).
    await assert.rejects(a.start(() => {}), /discord: gateway no Hello within 0\.1 s/);
    await until(() => dc.conns.length === 1 && dc.conns[0]!.closed, 'the silent connection to be closed');

    dc.state.upgrade = 'ok';
    await a.start(() => {});
    assert.equal(dc.identifies.length, 1);
    await a.stop();
  } finally {
    await dc.close();
  }
});

test('discord: after a dead connection, stalled reconnects are retried until the session resumes; receiving is reported', async () => {
  const dc = await fakeDiscord();
  dc.state.heartbeatInterval = 30;
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase, handshakeTimeoutMs: 100 });
  const links: LinkChange[] = [];
  const got: InboundMessage[] = [];
  try {
    await a.start((m) => got.push(m), undefined, (c) => links.push(c));
    await until(() => dc.state.beats >= 1, 'a heartbeat');

    // The connection dies quietly and the way back is stuck behind a proxy: no close, no Hello.
    dc.state.upgrade = 'hang';
    dc.state.ackBeats = false;
    await until(() => dc.hung.length >= 1, 'a reconnect attempt');
    assert.deepEqual(links[0], { receiving: false, reason: 'gateway heartbeat not acknowledged' });
    await until(() => links.length >= 2, 'the stalled attempt to be given up');
    assert.deepEqual(links[1], { receiving: false, reason: 'gateway connection not open within 0.1 s' });
    await until(() => dc.hung.every((s) => s.destroyed), 'stalled sockets to be closed');

    dc.state.upgrade = 'ok';
    dc.state.ackBeats = true;
    await until(() => dc.resumes.length === 1, 'a resume once the gateway answers', 15_000);
    await until(() => links.at(-1)?.receiving === true, 'receiving again');
    assert.deepEqual(links.at(-1), { receiving: true });
    dc.dispatch('MESSAGE_CREATE', inChannel('1000', '<@99> back'));
    await until(() => got.length === 1, 'a message on the resumed session');
  } finally {
    await a.stop();
    await dc.close();
  }
});

test('discord: a refused resume starts a new session and reports that events may be lost', async () => {
  const dc = await fakeDiscord();
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  const links: LinkChange[] = [];
  const got: InboundMessage[] = [];
  try {
    await a.start((m) => got.push(m), undefined, (c) => links.push(c));
    dc.dispatch('MESSAGE_CREATE', inChannel('1000', '<@99> one'));
    await until(() => got.length === 1, 'a message');
    const before = Date.now();

    dc.state.refuseResume = true;
    dc.current().end(4000);
    await until(() => dc.identifies.length === 2, 'a fresh identify after the refused resume', 15_000);
    assert.equal(dc.resumes.length, 1);
    await until(() => links.at(-1)?.receiving === true, 'receiving again');
    const back = links.at(-1) as { receiving: true; missedSince?: number };
    assert.ok(back.missedSince !== undefined && back.missedSince <= before, 'events since the last one received may be lost');
    assert.deepEqual(
      links.filter((l) => !l.receiving).map((l) => (l as { reason: string }).reason),
      ['gateway connection closed (4000)', 'gateway resume refused'],
    );
  } finally {
    await a.stop();
    await dc.close();
  }
});

test('discord: without Message Content, a blank message in a conversation thread gets one hint', async () => {
  const dc = await fakeDiscord();
  dc.channels['3000'] = { type: 11, name: 'hi', parent_id: '10' };
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  const got: InboundMessage[] = [];
  try {
    await a.start((m) => got.push(m));
    const hints = () => dc.writes().filter((c) => /Message Content intent/.test(c.body?.content ?? ''));
    // A blank message in a channel, and in a thread the bot has no part in: nothing.
    dc.dispatch('MESSAGE_CREATE', inChannel('1001', ''));
    dc.dispatch('MESSAGE_CREATE', inChannel('1002', '', { channel_id: '3000' }));
    // The bot is mentioned in the thread: now it is a conversation.
    dc.dispatch('MESSAGE_CREATE', inChannel('1003', '<@99> go on', { channel_id: '3000' }));
    await until(() => got.length === 1, 'the mention');
    assert.equal(hints().length, 0);

    dc.dispatch('MESSAGE_CREATE', inChannel('1004', '', { channel_id: '3000' }));
    await until(() => hints().length === 1, 'the hint');
    assert.equal(hints()[0]!.path, '/channels/3000/messages');
    assert.deepEqual(hints()[0]!.body.allowed_mentions, { parse: [] });
    dc.dispatch('MESSAGE_CREATE', inChannel('1005', '', { channel_id: '3000' }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1006', '<@99> and?', { channel_id: '3000' }));
    await until(() => got.length === 2, 'the next mention');
    assert.equal(hints().length, 1, 'once per thread');
  } finally {
    await a.stop();
  }

  // With the intent a blank message is a sticker or an embed: no hint.
  const b = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase, messageContent: true });
  try {
    await b.start(() => {});
    const writes = dc.writes().length;
    dc.dispatch('MESSAGE_CREATE', inChannel('1007', '<@99> x', { channel_id: '3000' }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1008', '', { channel_id: '3000' }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1009', '<@99> y', { channel_id: '3000' }));
    await until(() => dc.calls.length > 0 && dc.writes().length === writes, 'nothing written');
    await b.stop();
    assert.equal(dc.writes().length, writes);
  } finally {
    await dc.close();
  }
});

test('discord: a message mentioning the bot role instead of the bot gets a reply saying so; every ignored message is logged with why', async () => {
  const dc = await fakeDiscord();
  const logged: string[] = [];
  const log = mock.method(console, 'log', (line: string) => void logged.push(line));
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  const got: InboundMessage[] = [];
  try {
    await a.start((m) => got.push(m));
    const hints = () => dc.writes().filter((c) => /role, not the app/.test(c.body?.content ?? ''));
    // What Discord sends without the Message Content intent when the role is picked from the @ list.
    dc.dispatch('MESSAGE_CREATE', inChannel('1100', '', { mention_roles: ['r-bot'] }));
    await until(() => hints().length === 1, 'the hint');
    assert.equal(hints()[0]!.path, '/channels/10/messages');
    assert.equal(hints()[0]!.body.content, "You mentioned the @Bridge role, not the app, so I didn't read this. Mention the app instead: in the @ list, pick the entry marked APP.");
    assert.deepEqual(hints()[0]!.body.message_reference, { message_id: '1100', fail_if_not_exists: false });
    assert.deepEqual(hints()[0]!.body.allowed_mentions, { parse: [] });

    // Every time, since each was meant for the bot; the roles are looked up once per server.
    dc.dispatch('MESSAGE_CREATE', inChannel('1101', '', { mention_roles: ['r-bot'] }));
    // Another role, another bot, a join notice, a blank message: no reply, but a log line each.
    dc.dispatch('MESSAGE_CREATE', inChannel('1102', '', { mention_roles: ['r-mods'] }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1103', 'hi', { author: { id: '7', username: 'otherbot', bot: true } }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1104', '', { type: 7 }));
    dc.dispatch('MESSAGE_CREATE', inChannel('1105', '<@99> real'));
    await until(() => got.length === 1, 'the real mention');
    assert.equal(got[0]!.text, 'real');
    assert.equal(hints().length, 2);
    assert.equal(dc.calls.filter((c) => c.path === '/guilds/g/roles').length, 1);

    const ignored = logged.filter((l) => l.startsWith('discord: ignored'));
    assert.deepEqual(ignored, [
      'discord: ignored message 1100 in channel 10: mentions the Bridge role, not the app',
      'discord: ignored message 1101 in channel 10: mentions the Bridge role, not the app',
      'discord: ignored message 1102 in channel 10: blank: it does not mention the app, and the bot has no Message Content intent',
      'discord: ignored message 1103 in channel 10: sent by a bot',
      'discord: ignored message 1104 in channel 10: message type 7',
    ]);
  } finally {
    await a.stop();
    log.mock.restore();
    await dc.close();
  }
});

test('discord: a sticker is passed on as unreadable, so the bridge can tell the sender', async () => {
  const dc = await fakeDiscord();
  const a = new DiscordAdapter({ botToken: 'T', apiBase: dc.apiBase });
  const got: InboundMessage[] = [];
  try {
    await a.start((m) => got.push(m));
    dc.dispatch('MESSAGE_CREATE', inChannel('1200', '', { guild_id: undefined, channel_id: '20', sticker_items: [{ id: 's' }] }));
    await until(() => got.length === 1, 'the DM sticker');
    assert.deepEqual([got[0]!.isDM, got[0]!.text, got[0]!.unreadable], [true, '', 'stickers']);
  } finally {
    await a.stop();
    await dc.close();
  }
});
