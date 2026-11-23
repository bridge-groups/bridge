import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramAdapter } from '../adapters/im/telegram.ts';
import { until } from './helpers.ts';
import type { InboundMessage } from '../core/router.ts';
import type { InboundAction } from '../adapters/im/types.ts';

/** A local Bot API: getUpdates long-polls until updates are queued; sendMessage can be held. */
async function fakeTelegram() {
  const queue: object[] = [];
  /** Every call but getUpdates and getMe, in order. */
  const calls: { method: string; params: any }[] = [];
  const polls: { offset: number; timeout: number }[] = [];
  let waiting: ServerResponse | undefined;
  let hold: Promise<void> | undefined;
  let nextId = 500;
  let privacy: 'on' | 'off' = 'off';
  const reply = (res: ServerResponse, result: unknown) => res.end(JSON.stringify({ ok: true, result }));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.url!.startsWith('/file/botT/')) return res.end(`bytes of ${req.url!.slice('/file/botT/'.length)}`);
      const method = req.url!.split('/').pop()!;
      const params = JSON.parse(body || '{}');
      if (method === 'getMe') return reply(res, { id: 99, username: 'bot', can_read_all_group_messages: privacy === 'off' });
      if (method !== 'getUpdates') calls.push({ method, params });
      if (method === 'getFile') return reply(res, { file_id: params.file_id, file_path: `docs/${params.file_id}` });
      if (method === 'answerCallbackQuery' || method === 'editMessageText') return reply(res, true);
      if (method === 'sendMessage' && params.parse_mode === 'HTML' && params.text.includes('REFUSE')) {
        return res.end(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: unsupported start tag" }));
      }
      if (method === 'sendMessage') {
        await hold;
        return reply(res, { message_id: nextId++ });
      }
      if (method === 'getUpdates') {
        polls.push({ offset: params.offset, timeout: params.timeout });
        if (queue.length || params.timeout === 0) return reply(res, queue.splice(0));
        waiting = res;
        return;
      }
      res.end(JSON.stringify({ ok: false, description: 'unknown method' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    polls,
    calls,
    push(...updates: object[]) {
      queue.push(...updates);
      if (waiting) {
        const res = waiting;
        waiting = undefined;
        reply(res, queue.splice(0));
      }
    },
    setPrivacy(p: 'on' | 'off') {
      privacy = p;
    },
    holdSends(p: Promise<void> | undefined) {
      hold = p;
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const message = (update: number, id: number, text: string, replyTo?: { id: number; fromBot?: boolean }) => ({
  update_id: update,
  message: {
    message_id: id,
    text,
    chat: { id: 5, type: 'group', title: 'dev' },
    from: { id: 1, username: 'alice' },
    ...(replyTo ? { reply_to_message: { message_id: replyTo.id, from: { id: replyTo.fromBot ? 99 : 1 } } } : {}),
  },
});


test('telegram: offset is confirmed on stop and persisted, reply chains survive a restart, stop spares sends', async () => {
  const tg = await fakeTelegram();
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ab-tg-')), 'telegram.json');
  try {
    const got: InboundMessage[] = [];
    const a = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase, stateFile });
    await a.start((m) => got.push(m));
    tg.push(message(10, 100, 'hi'), message(11, 101, 'more', { id: 100 }));
    await until(() => got.length === 2, 'two messages');
    assert.deepEqual(got.map((m) => m.threadId), ['100', '100']);
    assert.equal(await a.send({ channelId: '5', threadId: '100', isDM: false, text: 'answer' }), '500');

    // A send in flight when stop() is called still completes.
    let release!: () => void;
    tg.holdSends(new Promise<void>((r) => (release = r)));
    const inFlight = a.send({ channelId: '5', threadId: '100', isDM: false, text: 'late' });
    const stopped = a.stop();
    release();
    assert.equal(await inFlight, '501');
    await stopped;
    tg.holdSends(undefined);
    assert.deepEqual(tg.polls.at(-1), { offset: 12, timeout: 0 }, 'handed-over updates confirmed to Telegram');

    const again: InboundMessage[] = [];
    const b = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase, stateFile });
    await b.start((m) => again.push(m));
    await until(() => tg.polls.at(-1)?.timeout === 30, 'the first poll after restart');
    assert.equal(tg.polls.at(-1)!.offset, 12, 'nothing is fetched twice');
    tg.push(message(12, 102, 'to the bot', { id: 500, fromBot: true }), message(13, 103, 'to alice', { id: 101 }));
    await until(() => again.length === 2, 'messages after restart');
    assert.deepEqual(again.map((m) => [m.threadId, m.mentioned]), [['100', true], ['100', false]], 'same thread as before the restart');
    await b.stop();
  } finally {
    await tg.close();
  }
});

const direct = (update: number, id: number, extra: object) => ({
  update_id: update,
  message: { message_id: id, chat: { id: 7, type: 'private' }, from: { id: 1, username: 'alice' }, ...extra },
});

test('telegram: attachments are passed on as files, a sticker as unreadable; service messages are dropped', async () => {
  const tg = await fakeTelegram();
  const got: InboundMessage[] = [];
  const a = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase });
  try {
    await a.start((m) => got.push(m));
    tg.push(
      direct(20, 200, { new_chat_members: [{ id: 3 }] }),
      direct(21, 201, { sticker: { file_id: 's' } }),
      direct(22, 202, { photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 90 }], caption: 'look' }),
      direct(23, 203, { document: { file_id: 'd', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 5 } }),
      direct(24, 204, { audio: { file_id: 'a', mime_type: 'audio/mpeg' } }),
      direct(25, 205, { document: { file_id: 'huge', file_name: 'huge.zip', file_size: 21 * 1024 * 1024 } }),
    );
    await until(() => got.length === 5, 'five messages');
    assert.deepEqual(
      got.map((m) => [m.text, m.unreadable, m.files?.map((f) => [f.name, f.mime, f.size])]),
      [
        ['', 'stickers', undefined],
        ['look', undefined, [['photo-202.jpg', 'image/jpeg', 90]]],
        ['', undefined, [['notes.txt', 'text/plain', 5]]],
        ['', undefined, [['audio-204.mpeg', 'audio/mpeg', undefined]]],
        ['', undefined, [['huge.zip', undefined, 21 * 1024 * 1024]]],
      ],
    );
    assert.equal(String(await got[1]!.files![0]!.download()), 'bytes of docs/big', 'the largest photo size');
    assert.equal(String(await got[2]!.files![0]!.download()), 'bytes of docs/d');
    await assert.rejects(got[4]!.files![0]!.download(), /up to 20 MB/);
    assert.ok(!tg.calls.some((c) => c.params.file_id === 'huge'), 'no getFile for a file over the limit');
  } finally {
    await a.stop();
    await tg.close();
  }
});

test('telegram: choices are inline buttons; a click is an action, answered by notifyUser or empty; resolving drops the buttons', async () => {
  const tg = await fakeTelegram();
  const actions: InboundAction[] = [];
  const a = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase });
  // Like the bridge: a click from someone who may not decide is answered at once.
  const onAction = (act: InboundAction) => {
    actions.push(act);
    if (act.userId === '2') void a.notifyUser(act.channelId, act.userId, 'Only me can decide this.');
  };
  try {
    await a.start(() => {}, onAction);
    const id = await a.sendChoice({ channelId: '5', threadId: '100', isDM: false, text: 'Approve?' }, [
      { label: 'Approve', value: 'c1|approve', style: 'primary' },
      { label: 'Deny', value: 'c1|deny', style: 'danger' },
    ]);
    const sent = tg.calls.find((c) => c.method === 'sendMessage')!.params;
    assert.equal(sent.parse_mode, 'HTML');
    assert.deepEqual(sent.reply_markup, { inline_keyboard: [[{ text: 'Approve', callback_data: 'c1|approve' }, { text: 'Deny', callback_data: 'c1|deny' }]] });
    assert.equal(sent.reply_parameters.message_id, 100);
    await assert.rejects(a.sendChoice({ channelId: '5', threadId: '100', isDM: false, text: 'x' }, [{ label: 'x', value: 'v'.repeat(65) }]), /64 bytes/);

    const click = (update: number, qid: string, from: number) => ({
      update_id: update,
      callback_query: { id: qid, from: { id: from }, data: 'c1|approve', message: { message_id: Number(id), chat: { id: 5 } } },
    });
    tg.push(click(30, 'q1', 1), click(31, 'q2', 2));
    await until(() => tg.calls.filter((c) => c.method === 'answerCallbackQuery').length === 2, 'both clicks answered');
    assert.deepEqual(actions.map((x) => [x.channelId, x.userId, x.messageId, x.value]), [
      ['5', '1', id, 'c1|approve'],
      ['5', '2', id, 'c1|approve'],
    ]);
    assert.deepEqual(
      tg.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params),
      [{ callback_query_id: 'q1' }, { callback_query_id: 'q2', text: 'Only me can decide this.', show_alert: true }],
    );

    // Later, with no click being handled, the note goes to the chat.
    await a.notifyUser('5', '2', 'Expired.');
    assert.deepEqual(tg.calls.at(-1), { method: 'sendMessage', params: { chat_id: '5', text: 'Expired.', parse_mode: 'HTML' } });

    await a.resolveChoice('5', id, '**Approve?**', '✅ Approved by me.');
    assert.deepEqual(tg.calls.at(-1), {
      method: 'editMessageText',
      params: { chat_id: '5', message_id: Number(id), text: '<b>Approve?</b>\n✅ Approved by me.', parse_mode: 'HTML' },
    });
  } finally {
    await a.stop();
    await tg.close();
  }
});

test('telegram: start warns while privacy mode keeps group mentions from the bot', async (t) => {
  const tg = await fakeTelegram();
  const logged = t.mock.method(console, 'error', () => {});
  try {
    const quiet = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase });
    await quiet.start(() => {});
    await quiet.stop();
    assert.equal(logged.mock.callCount(), 0);
    tg.setPrivacy('on');
    const warned = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase });
    await warned.start(() => {});
    await warned.stop();
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /privacy mode is on.*\/setprivacy/);
  } finally {
    await tg.close();
  }
});

test('telegram: replies are sent as HTML, and as the plain text when Telegram refuses the HTML', async () => {
  const tg = await fakeTelegram();
  const a = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase });
  try {
    await a.start(() => {});
    await a.send({ channelId: '7', threadId: '7', isDM: true, text: '**hi** `a<b`' });
    assert.deepEqual(tg.calls.at(-1)!.params, { chat_id: '7', text: '<b>hi</b> <code>a&lt;b</code>', parse_mode: 'HTML' });
    await a.send({ channelId: '7', threadId: '7', isDM: true, text: '**REFUSE**' });
    assert.deepEqual(tg.calls.slice(-2).map((c) => c.params), [
      { chat_id: '7', text: '<b>REFUSE</b>', parse_mode: 'HTML' },
      { chat_id: '7', text: '**REFUSE**' },
    ]);
  } finally {
    await a.stop();
    await tg.close();
  }
});
