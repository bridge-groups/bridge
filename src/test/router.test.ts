import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { Router, type InboundMessage } from '../core/router.ts';
import { PolicyEngine } from '../core/policy.ts';

const cfg = parseConfig(`
people: { alice: { slack: U1 }, bob: { slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  claude-code: { type: claude-code }
  data-agent: { type: webhook, url: "http://localhost:1/x" }
tools:
  github: { command: x }
  warehouse: { command: x }
routes:
  - { from: "slack:#dev", when: { mention: claude-code, sender: [alice] }, to: claude-code }
  - { from: "slack:#claude", when: { mention: false, sender: [alice] }, to: claude-code }
  - { from: "slack:#data", to: data-agent }
  - { from: "slack:dm", when: { sender: [alice, bob] }, to: claude-code }
  - { from: claude-code, to: [warehouse.query, "github.*", data-agent] }
policies:
  - { match: { tool: ["github.push*", "*.delete*"] }, approve_by: [initiator, alice], timeout: 5m }
  - { match: { agent: "*" }, max_hops: 3, budget_usd: 2 }
  - { match: { agent: data-agent }, budget_usd: 0.5 }
  - { match: { tool: "warehouse.*", writes: true }, approve_by: [alice] }
`);
const router = new Router(cfg);
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  platform: 'slack', channelId: 'C1', channelName: 'dev', isDM: false, userId: 'U1',
  text: 'hi', mentioned: true, threadId: 'T', messageId: 'M', ...o,
});

test('mention: <agent> route needs a mention that addresses the agent, and an allowed sender', () => {
  const hi = msg({ text: 'claude-code, hi' });
  assert.equal(router.matchInbound(hi, { personId: 'alice' })?.agent, 'claude-code');
  assert.equal(router.matchInbound(hi, { personId: 'alice' })?.text, 'hi');
  assert.equal(router.matchInbound(msg({ text: 'hi' }), { personId: 'alice' }), undefined, 'mentioned, but not addressed');
  assert.match(router.explainInbound(msg({ text: 'hi' }), { personId: 'alice' }).trace[0]!, /does not address "claude-code"/);
  assert.equal(router.matchInbound({ ...hi, mentioned: false }, { personId: 'alice' }), undefined);
  assert.equal(router.matchInbound(hi, { personId: 'bob' }), undefined);
  assert.equal(router.matchInbound(hi, {}), undefined);
});

test('mention: true / false / unset', () => {
  const r = new Router(parseConfig(`
people: { alice: { slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { a: { type: webhook, url: "http://localhost:1/x" } }
routes:
  - { from: "slack:#yes", when: { mention: true }, to: a }
  - { from: "slack:#no", when: { mention: false }, to: a }
  - { from: "slack:#unset", to: a }
  - { from: "slack:dm", when: { mention: true }, to: a }
`));
  const at = (channelName: string, mentioned: boolean, isDM = false) => r.matchInbound(msg({ channelName, mentioned, isDM }), {})?.index;
  assert.equal(at('yes', true), 0);
  assert.equal(at('yes', false), undefined);
  assert.equal(at('no', false), 1, 'mention: false takes every message');
  assert.equal(at('unset', true), 2);
  assert.equal(at('unset', false), undefined);
  assert.equal(at('dm', false, true), 3, 'a DM always counts as mentioned');
});

test('names that exist on Object.prototype are not agents', () => {
  assert.equal(router.matchInbound(msg({ channelName: 'data', text: 'constructor, hi' }), {})?.text, 'constructor, hi');
  assert.equal(router.matchInbound(msg({ channelName: 'data', text: 'toString' }), {})?.agent, 'data-agent');
});

test('thread replies continue without a fresh mention or address', () => {
  assert.equal(router.matchInbound(msg({ mentioned: false }), { personId: 'alice', threadAgent: 'claude-code' })?.agent, 'claude-code');
});

test('mention: false needs no mention', () => {
  assert.equal(router.matchInbound(msg({ channelName: 'claude', mentioned: false }), { personId: 'alice' })?.agent, 'claude-code');
});

test('a leading agent name addresses that agent and is stripped', () => {
  const m = router.matchInbound(msg({ channelName: 'data', text: 'data-agent, revenue last week?' }), {});
  assert.equal(m?.agent, 'data-agent');
  assert.equal(m?.text, 'revenue last week?');
  // addressing another agent skips routes for this one
  assert.equal(router.matchInbound(msg({ text: 'data-agent hi' }), { personId: 'alice' }), undefined);
});

test('DM routes', () => {
  assert.equal(router.matchInbound(msg({ isDM: true, channelName: 'dm', mentioned: false }), { personId: 'bob' })?.agent, 'claude-code');
});

test('a message that names no agent stays with the agent holding the conversation', () => {
  const two = new Router(
    parseConfig(`
people: { alice: { slack: U1 }, bob: { slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  cc: { type: claude-code }
  cx: { type: codex }
routes:
  - { from: "slack:dm", when: { sender: [alice, bob] }, to: cc }
  - { from: "slack:dm", when: { sender: [alice] }, to: cx }
  - { from: "slack:*", when: { mention: cc, sender: [alice] }, to: cc }
  - { from: "slack:*", when: { mention: cx, sender: [alice] }, to: cx }
`),
  );
  const dm = (text: string) => msg({ isDM: true, channelName: 'dm', mentioned: false, text });
  const to = (m: InboundMessage, personId: string, threadAgent?: string) => two.matchInbound(m, { personId, threadAgent })?.agent;

  // A new conversation goes to the first route; naming an agent picks it.
  assert.equal(to(dm('hi'), 'alice'), 'cc');
  assert.equal(to(dm('cx fix the login'), 'alice'), 'cx');
  // Once cx holds the DM, unnamed messages stay with it; naming cc switches back.
  assert.equal(to(dm('and the tests too'), 'alice', 'cx'), 'cx');
  assert.equal(two.explainInbound(dm('more'), { personId: 'alice', threadAgent: 'cx' }).trace[0], 'conversation is with cx: its routes are tried first');
  assert.equal(to(dm('cc review it'), 'alice', 'cx'), 'cc');
  // The holder's route must still match on its own: bob may not reach cx, so he gets the first route that allows him.
  assert.equal(to(dm('hi'), 'bob', 'cx'), 'cc');
  // In a channel thread, a fresh @mention without a name stays with the thread's agent too.
  assert.equal(to(msg({ text: 'next step' }), 'alice', 'cx'), 'cx');
});

test('explain gives a reason per route', () => {
  const { trace } = router.explainInbound(msg({ channelName: 'random' }), { personId: 'alice' });
  assert.ok(trace.every((l) => /does not match|different IM|no route matched/.test(l)), trace.join('\n'));
});

test('outbound routes cover agents and tools by glob', () => {
  assert.ok(router.allowsOutbound('claude-code', 'github.push_files'));
  assert.ok(router.allowsOutbound('claude-code', 'warehouse.query'));
  assert.ok(!router.allowsOutbound('claude-code', 'warehouse.drop_table'));
  assert.ok(router.allowsOutbound('claude-code', 'data-agent'));
  assert.ok(!router.allowsOutbound('data-agent', 'claude-code'));
  assert.ok(router.mayReachServer('claude-code', 'github'));
  assert.ok(!router.mayReachServer('data-agent', 'github'));
});

test('policies: strictest wins, approvers merge', () => {
  const p = new PolicyEngine(cfg);
  assert.equal(p.maxHops('claude-code'), 3);
  assert.equal(p.budgetUsd('data-agent'), 0.5);
  assert.equal(p.budgetUsd('claude-code'), 2);
  const a = p.approvalFor('claude-code', 'github.push_files');
  assert.deepEqual(a?.approvers, ['initiator', 'alice']);
  assert.equal(a?.timeoutMs, 5 * 60e3);
  assert.equal(p.approvalFor('claude-code', 'github.get_issue'), undefined);
  assert.ok(p.approvalFor('claude-code', 'warehouse.delete_rows'));
  assert.equal(p.approvalFor('claude-code', 'warehouse.query', { readOnly: true }), undefined, 'reads skip a writes-only policy');
  assert.deepEqual(p.approvalFor('claude-code', 'warehouse.insert', { readOnly: false })?.approvers, ['alice']);
});

test('policies: every match key must hold', () => {
  const p = new PolicyEngine(parseConfig(`
people: { alice: { slack: U1 } }
agents: { a: { type: webhook, url: "http://localhost:1/x" }, b: { type: webhook, url: "http://localhost:1/x" } }
policies:
  - { match: { agent: a, tool: "github.*" }, approve_by: [alice] }
  - { match: { agent: b }, approve_by: [initiator] }
  - { match: {}, max_hops: 2 }
`));
  assert.ok(p.approvalFor('a', 'github.push'));
  assert.equal(p.approvalFor('b', 'github.push')?.approvers.join(), 'initiator', 'the agent-a policy does not apply to b');
  assert.equal(p.approvalFor('a', 'other.tool'), undefined);
  assert.deepEqual(p.approvalFor('b', 'other.tool')?.approvers, ['initiator'], 'an agent-only policy covers all its tools');
  assert.equal(p.maxHops('a'), 2, 'an empty match applies to every agent');
});
