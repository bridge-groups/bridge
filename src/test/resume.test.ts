import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  store.upsertSession({ key, agent: 'cc', platform: 'slack', channel_id: 'C1', thread_id: 'T1', initiator: 'alice' });
  store.updateSession(key, { agentSession: { agent: 'cc', id: 'claude-123' } });
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

const twoAgents = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" }, cx: { type: stdio, command: "true" } }
routes:
  - { from: "slack:*", when: { sender: [alice] }, to: cc }
  - { from: "slack:*", when: { sender: [alice] }, to: cx }
`);

/** Agents that start session `<name>-<n>` when given none, and record every turn. */
async function switching() {
  const turns: { agent: string; turn: AgentTurn }[] = [];
  const fake = (name: string): AgentAdapter => {
    let started = 0;
    return {
      name,
      async run(turn) {
        turns.push({ agent: name, turn });
        return { text: `${name} did ${turn.envelope.content[0]?.type === 'text' ? turn.envelope.content[0].text : ''}`, agentSessionId: turn.agentSessionId ?? `${name}-${++started}` };
      },
    };
  };
  const im = new FakeIm();
  const store = new SqliteStore(':memory:');
  const bridge = new Bridge({ agentFactory: localAgents, cfg: twoAgents, store, ims: [im], agents: new Map([['cc', fake('cc')], ['cx', fake('cx')]]), log: () => {} });
  await bridge.start();
  const say = async (text: string) => {
    im.receive({ userId: 'U1', text });
    await bridge.idle();
  };
  return { turns, im, store, say, done: () => bridge.stop() };
}

test('switching agents in a conversation resumes each agent\'s own session and tells it what the others did', async () => {
  const { turns, store, say, done } = await switching();
  try {
    await say('fix the login');
    await say('cx add tests for it');
    await say('and run them');
    await say('cc review that');
    assert.deepEqual(turns.map((t) => [t.agent, t.turn.agentSessionId]), [
      ['cc', undefined],
      ['cx', undefined],
      ['cx', 'cx-1'],
      ['cc', 'cc-1'],
    ]);
    assert.equal(store.getSession('slack:C1:T1')?.agent, 'cc', 'cc holds the conversation again');
    // cx stays with its own session: unchanged turns get no note.
    assert.equal(turns[2]!.turn.text, 'and run them');
    const back = turns[3]!.turn.text;
    assert.match(back, /^\[bridge\] Since your last reply, other agents had turns in this conversation \(.*oldest first\):\n- alice → cx: add tests for it\n- cx: cx did add tests for it\n- alice → cx: and run them\n- cx: cx did and run them\n\n\[bridge\] The new message:\n\nreview that$/);
    assert.doesNotMatch(back, /fix the login/, 'what cc already saw is not repeated');
  } finally {
    await done();
  }
});

test('reset forgets every agent\'s session in the conversation', async () => {
  const { turns, store, say, done } = await switching();
  try {
    await say('hi');
    await say('cx hi');
    await say('reset');
    assert.equal(store.agentSession('slack:C1:T1', 'cc'), undefined);
    assert.equal(store.agentSession('slack:C1:T1', 'cx'), undefined);
    await say('cc hello again');
    assert.equal(turns.at(-1)!.turn.agentSessionId, undefined);
    assert.equal(turns.at(-1)!.turn.text, 'hello again');
  } finally {
    await done();
  }
});

test('a database from before per-agent sessions still loads; its single session ids, maybe another agent\'s, are dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-store-'));
  try {
    const path = join(dir, 'bridge.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE sessions (
        key TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session_id TEXT,
        platform TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        initiator TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0
      );
      INSERT INTO sessions VALUES ('slack:dm:U1', 'cc', 'claude-a', 'slack', 'D1', 'D1', 'alice', 1, 2, 0.5);
    `);
    old.close();
    const store = new SqliteStore(path);
    assert.equal(store.agentSession('slack:dm:U1', 'cc'), undefined);
    assert.equal(store.getSession('slack:dm:U1')?.agent, 'cc', 'the conversation and its holder stay');
    assert.equal(store.getSession('slack:dm:U1')?.spent_usd, 0.5);
    store.updateSession('slack:dm:U1', { agentSession: { agent: 'cc', id: 'claude-b' } });
    store.upsertSession({ key: 'slack:dm:U1', agent: 'cc', platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
    assert.equal(store.agentSession('slack:dm:U1', 'cc'), 'claude-b');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent taking over a conversation is never handed the previous agent\'s session id', async () => {
  const { turns, store, say, done } = await switching();
  try {
    await say('cx start here');
    assert.equal(store.agentSession('slack:C1:T1', 'cx'), 'cx-1');
    await say('cc hi');
    assert.equal(turns.at(-1)!.agent, 'cc');
    assert.equal(turns.at(-1)!.turn.agentSessionId, undefined, 'no --resume with codex\'s thread id');
    assert.equal(store.agentSession('slack:C1:T1', 'cc'), 'cc-1');
    assert.equal(store.agentSession('slack:C1:T1', 'cx'), 'cx-1', 'codex keeps its own');
  } finally {
    await done();
  }
});
