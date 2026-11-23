import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { localAgents } from '../adapters/agent/local.ts';
import { newEnvelope } from '../core/envelope.ts';
import { SqliteStore } from '../core/store.ts';
import type { AgentAdapter } from '../adapters/agent/types.ts';
import { FakeIm, scripted, until } from './helpers.ts';

// Every message addressed to the bot gets an answer: the agent's, or why not and what to do instead.

const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 }, bob: { trust: member, slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" }, cx: { type: stdio, command: "true" } }
tools: { fake: { command: node, args: [src/test/fixtures/tool-server.mjs] } }
policies: [ { match: { tool: "fake.delete*" }, approve_by: [initiator], timeout: 1m } ]
routes:
  - { from: cc, to: "fake.*" }
  - { from: "slack:#dev", when: { mention: cc, sender: [alice] }, to: cc }
  - { from: "slack:#dev", when: { mention: cx, sender: [alice] }, to: cx }
  - { from: "slack:dm", when: { sender: [alice] }, to: cc }
  - { from: "slack:dm", when: { mention: cx, sender: [alice] }, to: cx }
  - { from: "slack:#help", when: { mention: cx, sender: anyone }, to: cx }
`);

function agent(name: string, run?: AgentAdapter['run']): AgentAdapter {
  return { name, run: run ?? (async (t) => ({ text: `${name}: ${t.text}` })) };
}

async function setup(opts: { store?: SqliteStore; agents?: AgentAdapter[]; im?: FakeIm } = {}) {
  const im = opts.im ?? new FakeIm();
  const store = opts.store ?? new SqliteStore(':memory:');
  const agents = opts.agents ?? [agent('cc'), agent('cx')];
  const bridge = new Bridge({ agentFactory: localAgents, cfg, store, ims: [im], agents: new Map(agents.map((a) => [a.name, a])), log: () => {} });
  await bridge.start();
  return { im, store, bridge };
}

const said = (im: FakeIm) => im.sent.map((s) => s.text);

test('a mention without an agent name is answered with the agents this sender can start here', async () => {
  const { im, store, bridge } = await setup();
  try {
    im.receive({ userId: 'U1', text: '用 GitHub 工具看看' });
    await bridge.idle();
    assert.deepEqual(said(im), ['Which agent is this for? Start your message with `cc` or `cx`, for example "cc, summarise this thread".']);
    assert.equal(im.sent[0]!.threadId, 'T1', 'answered in the thread of the message');
    assert.equal(store.readTrace().at(-1)?.kind, 'ignored');

    // Bob may use no agent in #dev, so he isn't told about them; a DM names only what he may use there (nothing).
    im.receive({ userId: 'U2', text: 'cc, hi' });
    im.receive({ userId: 'U2', text: 'hi', isDM: true, channelName: 'dm', channelId: 'D2', threadId: 'D2' });
    await bridge.idle();
    assert.deepEqual(said(im).slice(1), [
      "No agent here takes messages from you, so this was not passed on. Ask the bridge's owner if you need access.",
      "No agent here takes messages from you, so this was not passed on. Ask the bridge's owner if you need access.",
    ]);
  } finally {
    await bridge.stop();
  }
});

test('naming an agent the sender cannot use here says so and names the ones they can', async () => {
  const { im, bridge } = await setup();
  try {
    im.receive({ userId: 'U1', text: 'cx, hi', channelName: 'help' });
    await bridge.idle();
    assert.ok(im.transcript().includes('cx: hi'), 'anyone may start cx in #help');
    im.receive({ userId: 'U1', text: 'cc, hi', channelName: 'help', threadId: 'T2' });
    await bridge.idle();
    assert.equal(said(im).at(-1), '`cc` doesn\'t take messages from you here. Start your message with `cx`, for example "cx, summarise this thread".');
  } finally {
    await bridge.stop();
  }
});

test('messages not addressed to the bot stay unanswered, so a busy channel never hears from it', async () => {
  const { im, store, bridge } = await setup();
  try {
    im.receive({ userId: 'U1', text: 'lunch?', mentioned: false });
    im.receive({ userId: 'U9', text: 'lunch?', mentioned: false });
    await bridge.idle();
    assert.deepEqual(said(im), []);
    assert.deepEqual(store.readTrace().map((r) => r.kind), ['bridge', 'ignored', 'ignored']);
  } finally {
    await bridge.stop();
  }
});

test('someone outside people hears one generic line a day that reveals nothing of the setup', async () => {
  const { im, store, bridge } = await setup();
  try {
    im.receive({ userId: 'U9', text: 'cc, deploy', isDM: true, channelName: 'dm', channelId: 'D9', threadId: 'D9' });
    await bridge.idle();
    im.receive({ userId: 'U9', text: 'hello?', isDM: true, channelName: 'dm', channelId: 'D9', threadId: 'D9' });
    im.receive({ userId: 'U9', text: 'cc, deploy' }); // #dev, mentioned
    await bridge.idle();
    assert.deepEqual(said(im), ['I only answer people this bridge is set up for. To get access, ask its owner to add your slack id U9.']);
    assert.doesNotMatch(said(im)[0]!, /`/, 'no agent names');
    assert.equal(store.readTrace().filter((r) => r.kind === 'ignored').length, 3, 'each one is still in the audit trail');
    // A route open to anyone is no secret to them: they hear how to use it.
    im.receive({ userId: 'U8', text: 'hi', channelName: 'help', threadId: 'T5' });
    await bridge.idle();
    assert.match(said(im)[1]!, /^Which agent is this for\? Start your message with `cx`/);
  } finally {
    await bridge.stop();
  }
});

test('a sticker or other unreadable message is answered when meant for the bot and never reaches an agent', async () => {
  let turns = 0;
  const { im, bridge } = await setup({ agents: [agent('cc', async () => (turns++, { text: 'x' })), agent('cx')] });
  try {
    const dm = { isDM: true, channelName: 'dm', channelId: 'D1', threadId: 'D1' };
    im.receive({ userId: 'U1', text: '', unreadable: 'stickers', ...dm });
    im.receive({ userId: 'U1', text: '', unreadable: 'stickers', mentioned: false });
    im.receive({ userId: 'U9', text: '', unreadable: 'stickers', isDM: true, channelName: 'dm', channelId: 'D9', threadId: 'D9' });
    await bridge.idle();
    assert.deepEqual(said(im), [
      "I can't read stickers. Please send it as text or a file.",
      'I only answer people this bridge is set up for. To get access, ask its owner to add your slack id U9.',
    ]);
    assert.equal(turns, 0);
  } finally {
    await bridge.stop();
  }
});

test('a message that has to wait for the turn in progress says it is queued', async () => {
  const release = Promise.withResolvers<void>();
  let started = 0;
  const slow = agent('cc', async (t) => {
    started++;
    if (started === 1) await release.promise;
    return { text: `cc: ${t.text}` };
  });
  const { im, bridge } = await setup({ agents: [slow, agent('cx')] });
  try {
    const dm = { isDM: true, channelName: 'dm', channelId: 'D1', threadId: 'D1' };
    im.receive({ userId: 'U1', text: 'first', ...dm });
    await until(() => started === 1, 'the first turn');
    im.receive({ userId: 'U1', text: 'second', ...dm });
    await until(() => said(im).some((t) => t.startsWith('⏳ Queued')), 'the queued note');
    assert.ok(said(im).includes("⏳ Queued: cc gets this after cc's current turn in this conversation ends."));
    release.resolve();
    await bridge.idle();
    assert.deepEqual(im.transcript().filter((t) => t.startsWith('cc:')), ['cc: first', 'cc: second']);
  } finally {
    await bridge.stop();
  }
});

test('a message queued behind a turn that waits for an approval or an answer says what to do to go on', async () => {
  const dm = { isDM: true, channelName: 'dm', channelId: 'D1', threadId: 'D1' };
  // The live case: a write tool waits for the owner's approval, and "cx hi" sent meanwhile seemed ignored.
  const cc = scripted('cc', async (mcp, turn) => {
    if (turn.text.includes('ask')) return String((await mcp.callTool({ name: 'ask_human', arguments: { question: 'which repo?' } })).isError);
    await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '1' } });
    return 'deleted';
  });
  const { im, bridge } = await setup({ agents: [cc, agent('cx')] });
  try {
    im.receive({ userId: 'U1', text: 'cc, delete it', ...dm });
    await until(() => said(im).some((t) => t.startsWith('🔐')), 'the approval request');
    im.receive({ userId: 'U1', text: 'cx, hi', ...dm });
    await until(() => said(im).some((t) => t.startsWith('⏳ Queued')), 'the queued note');
    assert.ok(said(im).includes("⏳ Queued: cx gets this after cc's current turn in this conversation, which is waiting for a decision above. Approve or deny it to go on; until then nothing else here runs."));
    im.receive({ userId: 'U1', text: 'approve', ...dm });
    await bridge.idle();
    assert.ok(im.transcript().includes('cx: hi'), 'the queue moves on once decided');

    im.receive({ userId: 'U1', text: 'cc, ask me', ...dm });
    await until(() => said(im).some((t) => t.startsWith('❓')), 'the question');
    im.receive({ userId: 'U1', text: 'cx, hi', ...dm });
    // That message answers the question (any text does); a message only queues when nothing waits for it.
    await bridge.idle();
    assert.ok(!said(im).some((t) => t.includes('waiting for an answer')));
  } finally {
    await bridge.stop();
  }
});

test('a queued message that expired while the bridge was away is reported in its thread', async () => {
  const store = new SqliteStore(':memory:');
  const thread = { platform: 'slack', channelId: 'C1', threadId: 'T1', isDM: false };
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: 'slack:C1:T1', content: [{ type: 'text', text: 'fix the bug' }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  store.enqueue(envelope.id, 'slack:C1:T1', { sessionKey: 'slack:C1:T1', agent: 'cc', text: 'fix the bug', envelope, thread });
  store.db.prepare('UPDATE queue SET created_at = ?').run(Date.now() - 2 * 86400e3);
  let turns = 0;
  const { im, bridge } = await setup({ store, agents: [agent('cc', async () => (turns++, { text: 'x' })), agent('cx')] });
  try {
    await bridge.idle();
    assert.deepEqual(said(im), [
      '⌛ A message to cc waited longer than 24h while the bridge was unavailable, so it was dropped: "fix the bug". Send it again if it is still needed.',
    ]);
    assert.equal(turns, 0);
    assert.equal(store.readTrace().find((r) => r.kind === 'expired')?.actor, 'cc');
  } finally {
    await bridge.stop();
  }
});

test('after a restart the owners hear that messages sent meanwhile on IMs that drop them got no answer', async () => {
  const store = new SqliteStore(':memory:');
  // Alice has a DM with the bot, so the owners can be told there.
  store.upsertSession({ key: 'slack:dm:U1', agent: 'cc', platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
  const first = await setup({ store });
  assert.deepEqual(said(first.im), [], 'nothing to say on a first start');
  await first.bridge.stop();
  store.db.prepare("UPDATE trace SET ts = ? WHERE kind = 'bridge'").run(Date.now() - 3 * 60e3);

  const second = await setup({ store });
  try {
    await second.bridge.idle();
    assert.deepEqual(said(second.im), [
      '🔄 The bridge is back after 3 min stopped. Messages sent to the bot on slack while it was not running never reached it, so they got no answer: please send anything unanswered again.',
    ]);
    assert.equal(second.im.sent[0]!.channelId, 'D1');
  } finally {
    await second.bridge.stop();
  }

  // Killed without a clean stop: the last thing it did is all that is known.
  store.trace('slack:C1:T1', 'inbound', 'alice', '{}');
  store.db.prepare('UPDATE trace SET ts = ? WHERE id = (SELECT max(id) FROM trace)').run(Date.now() - 5 * 3600e3);
  const third = await setup({ store });
  try {
    await third.bridge.idle();
    assert.match(said(third.im)[0]!, /^🔄 The bridge is back after an unexpected stop \(its last activity was 5 h ago\)\./);
  } finally {
    await third.bridge.stop();
  }

  // An IM that delivers what was sent meanwhile needs no such note.
  const replaying = Object.assign(new FakeIm(), { replaysMissed: true });
  const fourth = await setup({ store, im: replaying });
  try {
    await fourth.bridge.idle();
    assert.deepEqual(said(replaying), []);
  } finally {
    await fourth.bridge.stop();
  }
});

test('failures around a turn reach a person: the sender for an error before the turn, the owners for a lost reply', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertSession({ key: 'slack:dm:U1', agent: 'cc', platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
  let failSession = false;
  let failEnqueue = false;
  const getSession = store.getSession.bind(store);
  const enqueue = store.enqueue.bind(store);
  store.getSession = (key) => {
    if (failSession) throw new Error('database is locked');
    return getSession(key);
  };
  store.enqueue = (...args) => {
    if (failEnqueue) throw new Error('disk full');
    return enqueue(...args);
  };
  const im = new FakeIm();
  const { bridge } = await setup({ store, im });
  try {
    failSession = true;
    im.receive({ userId: 'U1', text: 'cc, hi' });
    im.receive({ userId: 'U9', text: 'cc, hi', threadId: 'T9' });
    await bridge.idle().catch(() => {});
    failSession = false;
    assert.deepEqual(said(im), [
      "⚠️ Something went wrong with this message, so it was not passed on: database is locked. Please try again; the bridge's log has the details.",
      "⚠️ Something went wrong with this message, so it was not passed on. Please try again; the bridge's log has the details.",
    ]);

    failEnqueue = true;
    im.receive({ userId: 'U1', text: 'cc, hi', threadId: 'T2' });
    await bridge.idle();
    failEnqueue = false;
    assert.equal(said(im)[2], '⚠️ cc could not take this message: disk full');

    // The thread can't be written to any more: the reply is lost, and the owners hear of it in their DM.
    im.onSend((m) => {
      if (m.threadId === 'T3') throw new Error('channel_not_found');
    });
    im.receive({ userId: 'U1', text: 'cc, hi', threadId: 'T3' });
    await bridge.idle();
    assert.equal(im.sent.at(-1)!.channelId, 'D1');
    assert.equal(said(im).at(-1), "⚠️ cc's reply in slack:C1:T3 was not delivered: channel_not_found. The reply is in the audit trail.");
  } finally {
    await bridge.stop();
  }
});
