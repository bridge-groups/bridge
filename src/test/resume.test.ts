import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { localAgents } from '../adapters/agent/local.ts';
import { newEnvelope } from '../core/envelope.ts';
import { SqliteStore } from '../core/store.ts';
import type { AgentAdapter, AgentTurn } from '../adapters/agent/types.ts';
import { FakeIm } from './helpers.ts';

const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" } }
routes: [ { from: "slack:*", when: { sender: [alice] }, to: cc } ]
`);

/** Leave a turn in the store as if the bridge died mid-turn after the agent reported its session id. */
function crashedTurn(store: SqliteStore, interrupted = 0) {
  const key = 'slack:C1:T1';
  store.upsertSession({ key, agent: 'cc', agent_session_id: 'claude-123', platform: 'slack', channel_id: 'C1', thread_id: 'T1', initiator: 'alice' });
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: key, content: [{ type: 'text', text: 'fix the bug' }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  const job = { sessionKey: key, agent: 'cc', text: 'fix the bug', envelope, thread: { platform: 'slack', channelId: 'C1', threadId: 'T1', isDM: false }, interrupted };
  store.enqueue(envelope.id, key, job);
  store.markRunning(envelope.id, job);
}

async function restart(store: SqliteStore) {
  const turns: AgentTurn[] = [];
  const cc: AgentAdapter = { name: 'cc', async run(t) { turns.push(t); return { text: 'resumed ok' }; } };
  const im = new FakeIm();
  const bridge = new Bridge({ agentFactory: localAgents, cfg, store, ims: [im], agents: new Map([['cc', cc]]), log: () => {} });
  await bridge.start();
  await bridge.idle();
  await bridge.stop();
  return { turns, im };
}

test('a turn cut off by a restart resumes the same agent session', async () => {
  const store = new SqliteStore(':memory:');
  crashedTurn(store);
  const { turns, im } = await restart(store);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.agentSessionId, 'claude-123');
  assert.match(turns[0]!.text, /interrupted because the bridge restarted[\s\S]*fix the bug/);
  assert.match(im.transcript().join('\n'), /🔁 The bridge restarted[\s\S]*resumed ok/);
  assert.equal(store.takePending(60e3).length, 0);
});

test('a turn interrupted too often is given up', async () => {
  const store = new SqliteStore(':memory:');
  crashedTurn(store, 2);
  const { turns, im } = await restart(store);
  assert.equal(turns.length, 0);
  assert.match(im.transcript().join('\n'), /interrupted 3 times/);
});
