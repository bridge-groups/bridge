import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { localAgents } from '../adapters/agent/local.ts';
import { SqliteStore } from '../core/store.ts';
import type { AgentAdapter } from '../adapters/agent/types.ts';
import { FakeIm, until } from './helpers.ts';

// defaults.external_budget: what one sender outside `people` may spend across all their conversations.

const yaml = (defaults = 'external_budget: { usd: 1, per: 24h }') => `
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cx: { type: stdio, command: "true" } }
routes:
  - { from: "slack:#dev", when: { sender: anyone }, to: cx }
defaults: { ${defaults} }
`;

/** An agent whose every turn costs `cost` and records the budget it was given. */
function costly(cost: number, seen: (number | undefined)[], gate?: () => Promise<void>): AgentAdapter {
  return {
    name: 'cx',
    async run(t) {
      seen.push(t.budgetUsd);
      await gate?.();
      return { text: `cx: ${t.text}`, costUsd: cost };
    },
  };
}

async function setup(agent: AgentAdapter, defaults?: string, store = new SqliteStore(':memory:')) {
  const im = new FakeIm();
  // Alice has a DM with the bot, so the owners can be told there.
  store.upsertSession({ key: 'slack:dm:U1', agent: 'cx', platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
  const bridge = new Bridge({ agentFactory: localAgents, cfg: parseConfig(yaml(defaults)), store, ims: [im], agents: new Map([['cx', agent]]), log: () => {} });
  await bridge.start();
  return { im, store, bridge };
}

const inThread = (im: FakeIm, thread: string) => im.sent.filter((s) => s.threadId === thread).map((s) => s.text);

test('external budget: a new thread brings no fresh budget; the sender is told once, the owners once', async () => {
  const seen: (number | undefined)[] = [];
  const { im, store, bridge } = await setup(costly(0.4, seen));
  try {
    for (const thread of ['T1', 'T2', 'T3']) {
      im.receive({ userId: 'U9', text: `hi from ${thread}`, threadId: thread });
      await bridge.idle();
    }
    assert.equal(seen.length, 2, '$0.20 left is less than the $0.40 a turn costs');
    assert.equal(seen[0], 1);
    assert.ok(Math.abs(seen[1]! - 0.6) < 1e-9, 'each turn is capped at what the sender has left');
    // The sender learns nothing of the setup: no amounts, no config keys.
    assert.ok(im.transcript().includes("💸 You've reached the usage limit for now. Try again in about 24 h."));
    await until(() => inThread(im, 'D1').length > 0, 'the owners to be told');
    assert.deepEqual(inThread(im, 'D1'), [
      '💸 slack:U9 (trust external) reached the $1 per 24h limit (defaults.external_budget). Their messages are not passed on for about 24 h; list them in people: with more trust to lift it.',
    ]);

    // Over the limit, further messages are dropped without an answer and without reaching the agent.
    const before = im.sent.length;
    im.receive({ userId: 'U9', text: 'and again', threadId: 'T4' });
    await bridge.idle();
    assert.equal(im.sent.length, before);
    assert.equal(seen.length, 2);
    const refusals = store.readTrace({ kinds: ['budget'] }).map((r) => JSON.parse(r.detail));
    assert.equal(refusals.length, 2);
    assert.equal(refusals[0].sender, 'slack:U9');
    assert.equal(refusals[0].limitUsd, 1);
    assert.equal(refusals[1].dropped, true);

    // People in people: are not limited by it.
    im.receive({ userId: 'U1', text: 'owner here', threadId: 'T5' });
    await bridge.idle();
    assert.equal(seen.length, 3);
    assert.equal(seen[2], undefined, 'no budget applies to the owner');

    const spend = (await bridge.status()).externalSpend;
    assert.equal(spend?.limitUsd, 1);
    assert.equal(spend?.senders.length, 1);
    assert.equal(spend?.senders[0]?.sender, 'slack:U9');
    assert.ok(Math.abs(spend!.senders[0]!.spentUsd - 0.8) < 1e-9);
    assert.ok(spend?.senders[0]?.limitedUntil, 'shown as over the limit');
  } finally {
    await bridge.stop();
  }
});

test('external budget: spending older than the window no longer counts', async () => {
  const seen: (number | undefined)[] = [];
  const store = new SqliteStore(':memory:');
  store.db.prepare('INSERT INTO spending (ts, sender, usd) VALUES (?, ?, ?)').run(Date.now() - 25 * 3600e3, 'slack:U9', 5);
  store.db.prepare('INSERT INTO spending (ts, sender, usd) VALUES (?, ?, ?)').run(Date.now() - 3600e3, 'slack:U9', 0.25);
  const { im, bridge } = await setup(costly(0.1, seen), undefined, store);
  try {
    im.receive({ userId: 'U9', text: 'hi' });
    await bridge.idle();
    assert.equal(seen.length, 1);
    assert.ok(Math.abs(seen[0]! - 0.75) < 1e-9);
  } finally {
    await bridge.stop();
  }
});

test("external budget: one sender's turns in parallel threads run one at a time", async () => {
  const seen: (number | undefined)[] = [];
  let open = Promise.withResolvers<void>();
  let running = 0;
  let most = 0;
  const gate = async () => {
    most = Math.max(most, ++running);
    await open.promise;
    running--;
  };
  const { im, bridge } = await setup(costly(0.4, seen, gate));
  try {
    im.receive({ userId: 'U9', text: 'one', threadId: 'T1' });
    im.receive({ userId: 'U9', text: 'two', threadId: 'T2' });
    await until(() => seen.length === 1, 'the first turn to start');
    open.resolve();
    open = Promise.withResolvers<void>();
    await until(() => seen.length === 2, 'the second turn to start');
    open.resolve();
    await bridge.idle();
    assert.equal(most, 1);
    assert.ok(Math.abs(seen[1]! - 0.6) < 1e-9, 'the second turn knows what the first cost');
  } finally {
    await bridge.stop();
  }
});

test('external budget: off leaves strangers to the conversation budgets alone', async () => {
  const seen: (number | undefined)[] = [];
  const { im, store, bridge } = await setup(costly(5, seen), 'external_budget: off');
  try {
    for (const thread of ['T1', 'T2']) {
      im.receive({ userId: 'U9', text: 'hi', threadId: thread });
      await bridge.idle();
    }
    assert.deepEqual(seen, [undefined, undefined]);
    assert.equal((await bridge.status()).externalSpend, undefined);
    assert.deepEqual(store.spendersSince(0), [], 'nothing recorded');
  } finally {
    await bridge.stop();
  }
});

test('external budget: on by default, $2 per rolling 24h', () => {
  const cfg = parseConfig(yaml('progress: off'));
  assert.deepEqual(cfg.defaults.external_budget, { usd: 2, per: '24h' });
});
