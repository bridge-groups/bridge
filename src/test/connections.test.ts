import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { localAgents } from '../adapters/agent/local.ts';
import { FailedIm } from '../adapters/im/failed.ts';
import { SlackAdapter } from '../adapters/im/slack.ts';
import { newEnvelope } from '../core/envelope.ts';
import { Redactor } from '../core/redact.ts';
import { SqliteStore } from '../core/store.ts';
import type { AgentAdapter } from '../adapters/agent/types.ts';
import type { ImAdapter } from '../adapters/im/types.ts';
import { FakeIm, until } from './helpers.ts';

const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1, feishu: ou_1 } }
im:
  slack: { app_token: env:A, bot_token: env:B }
  feishu: { app_id: cli_x, app_secret: env:F }
agents: { echo: { type: stdio, command: "true" } }
routes: [ { from: "slack:*", when: { sender: [alice] }, to: echo }, { from: "feishu:*", when: { sender: [alice] }, to: echo } ]
`);

const SECRET = 'feishu-app-secret-123456';
const echo: AgentAdapter = { name: 'echo', async run(t) { return { text: `echo: ${t.text}` }; } };

function setup(opts: { slack?: FakeIm; feishu?: ImAdapter; store?: SqliteStore } = {}) {
  const slack = opts.slack ?? new FakeIm('slack');
  const feishu = opts.feishu ?? new FakeIm('feishu');
  const store = opts.store ?? new SqliteStore(':memory:');
  // Alice has a DM with the bot on Slack, so the owners can be told there.
  store.upsertSession({ key: 'slack:dm:U1', agent: 'echo', platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
  const redactor = new Redactor();
  redactor.add(SECRET);
  const logs: string[] = [];
  const bridge = new Bridge({
    agentFactory: localAgents,
    cfg,
    store,
    ims: [slack, feishu],
    agents: new Map([['echo', echo]]),
    redactor,
    imRetry: { firstMs: 20, maxMs: 40 },
    imQuietMs: 50,
    log: (l) => logs.push(l),
  });
  return { slack, feishu, store, bridge, logs };
}

const connection = async (bridge: Bridge, platform: string) => (await bridge.status()).connections.find((c) => c.platform === platform)!;

test('an IM that fails to connect stays down alone: the others route, status says why, the owner is told once', async () => {
  const feishu = new FakeIm('feishu').failStart(`failed to get tenant_access_token, code: 10014, msg: app secret invalid (${SECRET})`);
  const { slack, store, bridge, logs } = setup({ feishu });
  await bridge.start();
  try {
    slack.receive({ userId: 'U1', text: 'hello' });
    await until(() => slack.transcript().includes('echo: hello'), 'the Slack reply');

    const down = await connection(bridge, 'feishu');
    assert.equal(down.state, 'down');
    assert.match(down.error!, /app secret invalid \(\[redacted\]\)/);
    assert.ok(down.retryAt! > down.since);
    assert.equal((await connection(bridge, 'slack')).state, 'connected');

    await until(() => slack.sent.some((m) => m.channelId === 'D1'), 'the DM to the owner');
    const dm = slack.sent.filter((m) => m.channelId === 'D1');
    assert.equal(dm.length, 1);
    assert.match(dm[0]!.text, /feishu is not connected: .*app secret invalid/);
    // Retries keep failing, but the owner is not told again, and the secret never reaches a log, DM or trace.
    await until(() => feishu.starts >= 3, 'two retries');
    assert.equal(slack.sent.filter((m) => m.channelId === 'D1').length, 1);
    await bridge.idle();
    assert.equal(store.readTrace().filter((t) => t.kind === 'im').length, 1);
    for (const text of [...logs, ...slack.sent.map((m) => m.text), ...store.readTrace().map((t) => t.detail)]) {
      assert.ok(!text.includes(SECRET), text);
    }
  } finally {
    await bridge.stop();
  }
  assert.equal(feishu.stops, 0, 'a down IM holds no connection to close');
  assert.equal(slack.stops, 1);
});

test('a down IM is retried with backoff; its queued work waits for it, and the owner hears it is back', async () => {
  const store = new SqliteStore(':memory:');
  // Work left for Feishu by the last run.
  const key = 'feishu:oc_1:om_1';
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'feishu', platformUserId: 'ou_1' },
    sessionKey: key, content: [{ type: 'text', text: 'queued' }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  store.enqueue(envelope.id, key, { sessionKey: key, agent: 'echo', text: 'queued', envelope, thread: { platform: 'feishu', channelId: 'oc_1', threadId: 'om_1', isDM: false } });

  let connectedAt = 0;
  const feishu = new FakeIm('feishu').failStart('getaddrinfo ENOTFOUND open.feishu.cn', 2);
  const sent = feishu.send.bind(feishu);
  feishu.send = async (m) => {
    assert.ok(connectedAt, 'nothing is sent on Feishu before it connects');
    return sent(m);
  };
  const { slack, bridge } = setup({ feishu, store });
  const start = feishu.start.bind(feishu);
  feishu.start = async (...args) => {
    await start(...args);
    connectedAt = Date.now();
  };
  await bridge.start();
  try {
    assert.equal((await connection(bridge, 'feishu')).state, 'down');
    await until(async () => (await connection(bridge, 'feishu')).state === 'connected', 'Feishu to connect');
    assert.equal(feishu.starts, 3);
    await until(() => feishu.transcript().includes('echo: queued'), 'the queued reply on Feishu');
    await until(() => slack.sent.some((m) => m.channelId === 'D1' && /feishu is connected again/.test(m.text)), 'the all-clear');
    const c = await connection(bridge, 'feishu');
    assert.equal(c.error, undefined);
    assert.equal(c.retryAt, undefined);
  } finally {
    await bridge.stop();
  }
});

test('an IM that stops receiving is reconnecting: replies still go out, the owner hears after a while and when it is back, and of lost messages', async () => {
  const feishu = new FakeIm('feishu');
  const { slack, bridge, logs } = setup({ feishu });
  await bridge.start();
  try {
    const ownerDms = () => slack.sent.filter((m) => m.channelId === 'D1').map((m) => m.text);
    feishu.link({ receiving: false, reason: `gateway heartbeat not acknowledged (${SECRET})` });
    const quiet = await connection(bridge, 'feishu');
    assert.equal(quiet.state, 'reconnecting');
    assert.match(quiet.error!, /heartbeat not acknowledged \(\[redacted\]\)/);
    // A later failure updates the reason but not when it started.
    feishu.link({ receiving: false, reason: 'gateway no Hello within 30 s' });
    assert.equal((await connection(bridge, 'feishu')).since, quiet.since);
    assert.equal((await connection(bridge, 'feishu')).error, 'gateway no Hello within 30 s');

    // Sending is not blocked: a reply still goes out on it.
    feishu.receive({ userId: 'ou_1', text: 'still there?' });
    await until(() => feishu.transcript().includes('echo: still there?'), 'the reply while reconnecting');

    await until(() => ownerDms().length === 1, 'the owner told it went quiet');
    assert.match(ownerDms()[0]!, /feishu has not received anything for .*no Hello within 30 s.*replies still go out/);

    feishu.link({ receiving: true, missedSince: Date.now() - 3 * 60e3 });
    const back = await connection(bridge, 'feishu');
    assert.equal(back.state, 'connected');
    assert.equal(back.error, undefined);
    await until(() => ownerDms().length === 2, 'the all-clear');
    assert.match(ownerDms()[1]!, /feishu is receiving messages again/);
    assert.match(ownerDms()[1]!, /new session, so messages sent to the bot in the last 3 min may not have arrived/);
    assert.ok(logs.some((l) => /may not have arrived/.test(l)), 'the loss is logged');

    // A short drop that resumes: no DM at all.
    feishu.link({ receiving: false, reason: 'connection closed (1006)' });
    feishu.link({ receiving: true });
    assert.equal((await connection(bridge, 'feishu')).state, 'connected');
    await bridge.idle();
    assert.equal(ownerDms().length, 2);
    assert.ok(!logs.some((l) => l.includes(SECRET)));
  } finally {
    await bridge.stop();
  }
});

test('with every IM down the bridge still starts, reports both, and stops cleanly', async () => {
  const slack = new FakeIm('slack').failStart('invalid_auth');
  const feishu = new FakeIm('feishu').failStart('app secret invalid');
  const { bridge, logs } = setup({ slack, feishu });
  await bridge.start();
  try {
    const { connections } = await bridge.status();
    assert.deepEqual(connections.map((c) => [c.platform, c.state, c.error]), [['slack', 'down', 'invalid_auth'], ['feishu', 'down', 'app secret invalid']]);
    await until(() => logs.some((l) => /no owner could be told/.test(l)), 'the undelivered notice to be logged');
  } finally {
    await bridge.stop();
  }
  assert.equal(slack.stops + feishu.stops, 0);
});

test('Slack: a start retried after a failure adds no second event handler', async () => {
  const slack = new SlackAdapter({ appToken: 'xapp-test', botToken: 'xoxb-test' });
  const internals = slack as unknown as { web: { auth: { test: () => Promise<unknown> } }; socket: { listenerCount(e: string): number } };
  internals.web.auth.test = async () => {
    throw new Error('invalid_auth');
  };
  for (let i = 0; i < 2; i++) await assert.rejects(slack.start(() => {}), /invalid_auth/);
  assert.equal(internals.socket.listenerCount('message'), 1);
  assert.equal(internals.socket.listenerCount('interactive'), 1);
});

test('an IM whose credential could not be read is down with that reason, and the others start', async () => {
  const reason = 'secret "feishu_app_secret" not found — run: bridge secret set feishu_app_secret';
  const { slack, bridge } = setup({ feishu: new FailedIm('feishu', reason) });
  await bridge.start();
  try {
    assert.equal((await connection(bridge, 'slack')).state, 'connected');
    const c = await connection(bridge, 'feishu');
    assert.equal(c.state, 'down');
    assert.equal(c.error, reason);
    await until(() => slack.sent.some((m) => m.channelId === 'D1' && m.text.includes(reason)), 'the DM to the owner');
  } finally {
    await bridge.stop();
  }
});
