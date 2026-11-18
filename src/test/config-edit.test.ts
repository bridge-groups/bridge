import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConfig, parseConfig } from '../config/load.ts';
import { configChanges } from '../config/changes.ts';
import { AppliedConfig, askOwners, ConfigGate, configSha, type ConfigEvent, type PendingConfig } from '../config/gate.ts';
import { configJsonSchema, SCHEMA_FILE } from '../config/json-schema.ts';
import type { BridgeConfig } from '../config/schema.ts';
import { TEMPLATE } from '../template.ts';
import { Bridge } from '../core/bridge.ts';
import { SqliteStore } from '../core/store.ts';
import { FakeIm, until } from './helpers.ts';

const BASE = `server: { port: 0 }
people:
  alice: { trust: owner, slack: U1 }
  bob: { trust: member, slack: U2 }
im:
  slack: { app_token: secret:slack_app_token, bot_token: secret:slack_bot_token }
agents:
  echo: { type: stdio, command: "true" }
  helper: { type: stdio, command: "true" }
tools:
  gh: { url: "https://example.com/mcp", headers: { Authorization: "Bearer \${secret:gh}" } }
routes:
  - { from: "slack:#dev", when: { sender: [alice] }, to: echo }
  - { from: echo, to: ["gh.get_*"] }
policies:
  - { match: { tool: "gh.*", writes: true }, approve_by: [initiator] }
`;

const cfg = (text: string): BridgeConfig => parseConfig(text);

// ───────────────────────── checking a file ─────────────────────────

test('check: every problem names its line and key path', () => {
  const syntax = checkConfig('people:\n  alice: [\n');
  assert.equal(syntax.config, undefined);
  assert.ok(syntax.issues[0]!.line! >= 2);

  const text = BASE.replace('to: echo }', 'to: nobody }').replace('trust: member', 'trust: boss');
  const { config, issues } = checkConfig(text);
  assert.equal(config, undefined);
  const trust = issues.find((i) => i.path.join('.') === 'people.bob.trust')!;
  assert.equal(trust.line, 4);
  // Semantic problems are only reported once the schema holds; fix the trust level and look again.
  const semantic = checkConfig(BASE.replace('to: echo }', 'to: nobody }')).issues;
  assert.deepEqual(semantic.map((i) => [i.path.join('.'), i.line]), [['routes.0.to', 13]]);
});

test('check: credentials written into the file are refused; references are fine', () => {
  assert.ok(checkConfig(BASE).config, 'secret: refs and ${secret:x} in headers pass');
  const leaked = BASE.replace('bot_token: secret:slack_bot_token', 'bot_token: xoxb-1234567890-abcdefghijkl');
  const { config, issues } = checkConfig(leaked);
  assert.equal(config, undefined);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]!.path, ['im', 'slack', 'bot_token']);
  assert.equal(issues[0]!.line, 6);
  assert.match(issues[0]!.message, /bridge secret set/);
  const header = BASE.replace('Bearer ${secret:gh}', 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(checkConfig(header).config, undefined);
});

test('check: the tests section is run on load, and a failing test keeps the file from applying', () => {
  const passing = `${BASE}tests:
  - { from: "slack:#dev", sender: alice, mention: true, expect: echo }
  - { from: "slack:#dev", sender: bob, mention: true, expect: none }
  - { from: "slack:#dev", sender: U1, expect: none }
  - { from: "slack:dm", sender: alice, expect: none }
  - { agent: echo, calls: gh.get_issue, expect: allow }
  - { agent: echo, calls: gh.create_issue, expect: deny }
`;
  assert.ok(checkConfig(passing).config);

  const failing = `${BASE}tests:
  - { from: "slack:#dev", sender: alice, mention: true, expect: echo }
  - { from: "slack:#dev", sender: bob, mention: true, expect: echo }
  - { agent: echo, calls: gh.create_issue, expect: allow }
`;
  const { config, issues } = checkConfig(failing);
  assert.equal(config, undefined);
  assert.deepEqual(issues.map((i) => i.path.join('.')), ['tests.1', 'tests.2']);
  assert.match(issues[0]!.message, /expected echo, got none \(.*sender bob not allowed/);
  assert.match(issues[1]!.message, /expected allow, got deny/);
  assert.equal(issues[0]!.line, 19);

  assert.match(checkConfig(`${BASE}tests:\n  - { from: "slack:#dev", expect: ghost }\n`).issues[0]!.message, /neither an agent nor "none"/);
});

test('check: the init template is valid and its own tests pass; the schema in doc/ is current', () => {
  assert.ok(checkConfig(TEMPLATE).config);
  assert.ok(TEMPLATE.startsWith(`# yaml-language-server: $schema=${SCHEMA_FILE}\n`));
  assert.equal(readFileSync(SCHEMA_FILE, 'utf8'), configJsonSchema(), 'regenerate with: node src/cli.ts schema > doc/bridge.schema.json');
});

// ───────────────────────── what widens access ─────────────────────────

test('changes: new reach widens access, removed reach does not', () => {
  const base = cfg(BASE);
  const widened = (text: string) =>
    configChanges(base, cfg(text))
      .filter((c) => c.widens)
      .map((c) => `${c.section} ${c.kind} ${c.key}`);
  const narrowed = (text: string) => configChanges(base, cfg(text)).filter((c) => !c.widens).map((c) => `${c.section} ${c.kind}`);

  assert.deepEqual(configChanges(base, cfg(BASE)), []);
  assert.deepEqual(widened(BASE.replace('sender: [alice]', 'sender: [alice, bob]')), [
    'routes added slack:#dev → echo (sender: alice, bob)',
  ]);
  assert.deepEqual(narrowed(BASE.replace('sender: [alice]', 'sender: [alice, bob]')), ['routes removed']);
  assert.deepEqual(widened(BASE.replace('slack: U2', 'slack: U9')), ['people changed bob']);
  assert.deepEqual(widened(BASE.replace('command: "true" }\n  helper', 'command: "rm" }\n  helper')), ['agents changed echo']);
  assert.deepEqual(widened(BASE.replace('policies:\n  - { match: { tool: "gh.*", writes: true }, approve_by: [initiator] }\n', 'policies: []\n')), [
    'policies removed match {tool: gh.*; writes: true} approve_by: initiator',
  ]);
  // Route order decides who wins.
  const swapped = BASE.replace(
    '  - { from: "slack:#dev", when: { sender: [alice] }, to: echo }\n  - { from: echo, to: ["gh.get_*"] }',
    '  - { from: echo, to: ["gh.get_*"] }\n  - { from: "slack:#dev", when: { sender: [alice] }, to: echo }',
  );
  assert.deepEqual(widened(swapped), ['routes reordered order']);

  // Pure narrowing or housekeeping applies without anyone confirming it.
  const quiet = (text: string) => configChanges(base, cfg(text)).every((c) => !c.widens);
  assert.ok(quiet(BASE.replace('  - { from: echo, to: ["gh.get_*"] }\n', '')), 'a removed route');
  assert.ok(quiet(`${BASE}  - { match: { agent: echo }, budget_usd: 1 }\n`), 'a new limit');
  assert.ok(!quiet(`${BASE}  - { match: { tool: "gh.*" }, approve_by: [bob] }\n`), 'a new approver widens');
  assert.ok(quiet(`${BASE}defaults: { progress: verbose }\n`), 'housekeeping');
  assert.ok(!quiet(`${BASE}defaults: { max_hops: 9 }\n`), 'more hops widen');
  assert.ok(!quiet(BASE.replace('server: { port: 0 }', 'server: { port: 0, host: 0.0.0.0 }')), 'a public listener widens');
});

test('changes: an agent or tool server is compared setting by setting', () => {
  const AGENTS = `people: { alice: { trust: owner, slack: U1 } }
agents:
  cc: { type: claude-code, permission_mode: acceptEdits, allowed_tools: ["Bash(git status:*)", "Bash(npm test:*)"], worktree: true }
  cx: { type: codex, sandbox: workspace-write }
tools:
  gh: { url: "https://example.com/mcp" }
routes:
  - { from: "local:dm", when: { sender: [alice] }, to: cc }
`;
  const base = cfg(AGENTS);
  const change = (from: string, to: string) => {
    const next = AGENTS.replace(from, to);
    assert.notEqual(next, AGENTS, `no "${from}" in the fixture`);
    const [c, ...rest] = configChanges(base, cfg(next));
    assert.equal(rest.length, 0);
    return { widens: c!.widens, fields: c!.fields };
  };

  // Descriptive and pacing settings need no one.
  assert.deepEqual(change('worktree: true }', 'worktree: true, description: "new words", model: opus }'), {
    widens: false,
    fields: ['description', 'model'],
  });
  assert.deepEqual(change('{ url: "https://example.com/mcp" }', '{ url: "https://example.com/mcp", timeout: 10m }'), { widens: false, fields: ['timeout'] });
  // Moving toward less access narrows; toward more widens.
  assert.equal(change('permission_mode: acceptEdits', 'permission_mode: plan').widens, false);
  assert.equal(change('permission_mode: acceptEdits', 'permission_mode: bypassPermissions').widens, true);
  assert.equal(change('sandbox: workspace-write', 'sandbox: read-only').widens, false);
  assert.equal(change('sandbox: workspace-write', 'sandbox: danger-full-access').widens, true);
  assert.equal(change(', "Bash(npm test:*)"]', ']').widens, false, 'a pre-approved tool removed');
  assert.equal(change('"Bash(npm test:*)"]', '"Bash(npm test:*)", "Bash(rm:*)"]').widens, true, 'a pre-approved tool added');
  assert.equal(change('worktree: true', 'worktree: false').widens, true, 'off its own branch, onto your checkout');
  // Anything that says where or what it runs widens, even next to an inert change.
  assert.deepEqual(change('type: codex, sandbox', 'type: codex, description: x, cwd: /tmp, sandbox'), { widens: true, fields: ['cwd', 'description'] });
  assert.equal(change('example.com/mcp', 'example.org/mcp').widens, true);
  // Changing the type replaces the agent's settings wholesale.
  assert.equal(change('cx: { type: codex, sandbox: workspace-write }', 'cx: { type: stdio, command: "true" }').widens, true);
});

// ───────────────────────── the gate ─────────────────────────

function gateFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-gate-'));
  const path = join(dir, 'bridge.yaml');
  writeFileSync(path, BASE);
  const applied: BridgeConfig[] = [];
  const pending: { p: PendingConfig; signal: AbortSignal }[] = [];
  const events: ConfigEvent[] = [];
  const make = () => {
    const gate = new ConfigGate({
      path,
      applied: new AppliedConfig(join(dir, 'state', 'applied.yaml')),
      apply: (c) => applied.push(c),
      log: () => {},
      onPending: (p, signal) => pending.push({ p, signal }),
    });
    gate.onAudit((e) => events.push(e));
    return gate;
  };
  return { path, applied, pending, events, make, edit: (text: string) => writeFileSync(path, text) };
}

test('gate: narrowing edits apply at once; widening ones wait for an owner, also across restarts', () => {
  const f = gateFixture();
  let gate = f.make();
  assert.equal(gate.initial().routes.length, 2, 'nothing applied before: the file applies');

  f.edit(BASE.replace('  - { from: echo, to: ["gh.get_*"] }\n', ''));
  gate.offer();
  assert.equal(f.applied.length, 1, 'a removed route applies on its own');
  assert.equal(f.applied[0]!.routes.length, 1);

  const wider = BASE.replace('sender: [alice]', 'sender: [alice, bob]');
  f.edit(wider);
  gate.offer();
  assert.equal(f.applied.length, 1, 'held');
  assert.equal(f.pending.length, 1);
  assert.equal(gate.pending()?.sha, configSha(wider));
  gate.offer();
  assert.equal(f.pending.length, 1, 'the same file is not asked about twice');

  // A restart doesn't slip it in: the bridge starts with what was applied, and asks again.
  gate = f.make();
  assert.equal(gate.initial().routes.length, 1);
  gate.offer();
  assert.equal(f.pending.length, 2);

  assert.throws(() => gate.confirm('000000000000', 'alice'), /changed since/);
  const changes = gate.confirm(configSha(wider), 'alice');
  assert.ok(changes.some((c) => c.widens));
  assert.equal(f.applied.at(-1)!.routes.length, 2);
  assert.ok(f.pending[1]!.signal.aborted, 'the IM question is withdrawn');
  assert.equal(gate.pending(), undefined);
  assert.deepEqual(
    f.events.map((e) => [e.outcome, e.by ?? '-']),
    [['applied', '-'], ['applied', '-'], ['pending', '-'], ['pending', '-'], ['applied', 'alice']],
  );
  // Confirmed and recorded: the next start takes the file as it is.
  assert.equal(f.make().initial().routes.length, 2);
});

test('gate: a record this version cannot read holds everything until an owner confirms the file', () => {
  const f = gateFixture();
  f.make().initial();
  // As if written by a version whose schema had a setting this one dropped.
  writeFileSync(join(f.path, '..', 'state', 'applied.yaml'), `${BASE}defaults: { gone: 1 }\n`);
  assert.throws(() => f.make().initial(), /not valid for this version.*bridge check --apply/);
  const gate = f.make();
  gate.offer();
  assert.equal(f.applied.length, 0, 'nothing applies unreviewed');
  assert.deepEqual(gate.confirm(configSha(BASE), 'alice'), [], 'confirming the whole file moves on');
  assert.equal(f.applied.length, 1);
  assert.equal(f.make().initial().routes.length, 2);
});

test('gate: a rejected change stays out until the file changes; an invalid file keeps the running config', () => {
  const f = gateFixture();
  const gate = f.make();
  gate.initial();
  const wider = BASE.replace('slack: U2', 'slack: U9');
  f.edit(wider);
  gate.offer();
  gate.reject(configSha(wider), 'alice');
  assert.equal(gate.pending(), undefined);
  gate.offer();
  assert.equal(f.pending.length, 1, 'not asked again');
  assert.equal(f.applied.length, 0);

  f.edit('people: [');
  gate.offer();
  assert.equal(f.applied.length, 0);
  assert.equal(gate.pending(), undefined);

  f.edit(`${wider}\n# edited again\n`);
  gate.offer();
  assert.equal(f.pending.length, 2, 'a new edit is a new question');
});

// ───────────────────────── asking the owner in IM ─────────────────────────

test('config confirmation: owners are asked in their DM, and a click applies the change everywhere', async () => {
  const f = gateFixture();
  const im = new FakeIm().withButtons();
  const store = new SqliteStore(':memory:');
  let bridge: Bridge | undefined;
  let running: BridgeConfig;
  const gate: ConfigGate = new ConfigGate({
    path: f.path,
    applied: new AppliedConfig(join(f.path, '..', 'state', 'applied.yaml')),
    apply: (c) => {
      running = c;
      bridge!.reload(c);
    },
    log: () => {},
    onPending: (p, signal) => void askOwners(bridge!, running, gate, p, signal),
  });
  running = gate.initial();
  bridge = new Bridge({ cfg: running, store, ims: [im], agents: new Map([['echo', { name: 'echo', async run() { return { text: 'hi' }; } }]]), log: () => {} });
  await bridge.start();
  try {
    // Alice has talked to the bot in a DM, so the bridge knows where to ask her.
    store.upsertSession({ key: 'slack:dm:U1', agent: 'echo', agent_session_id: null, platform: 'slack', channel_id: 'D1', thread_id: 'D1', initiator: 'alice' });
    const wider = BASE.replace('sender: [alice]', 'sender: [alice, bob]');
    f.edit(wider);
    gate.offer();
    await until(() => im.choiceMessages.size === 1);
    const [id, msg] = [...im.choiceMessages][0]!;
    assert.equal(im.sent[0]!.channelId, 'D1');
    assert.match(msg.text, /widens access/);
    assert.match(msg.text, /\+ routes added: slack:#dev → echo \(sender: alice, bob\)/);
    assert.deepEqual(bridge.pendingChoices(), [], 'listed in its own dashboard section, not twice');
    assert.equal(gate.pending()?.sha, configSha(wider));

    im.click(id, 'Apply', 'U2');
    await until(() => im.notices.length === 1);
    assert.equal(gate.pending()?.sha, configSha(wider), 'bob is not an owner');

    im.click(id, 'Apply', 'U1');
    await until(() => msg.outcome !== undefined);
    assert.equal(msg.outcome, '✅ Applied by alice.');
    assert.equal(gate.pending(), undefined);
    // Now bob reaches echo in #dev.
    im.receive({ userId: 'U2', text: 'hello', channelName: 'dev' });
    await bridge.idle();
    assert.ok(im.transcript().includes('hi'), 'bob reaches echo once the change applies');

    // Decided elsewhere (the dashboard, the CLI): the question in the DM is withdrawn.
    f.edit(wider.replace('slack: U2', 'slack: U3'));
    gate.offer();
    await until(() => im.choiceMessages.size === 2);
    assert.throws(() => gate.confirm('nope', 'alice (cli)'), /changed since/);
    gate.reject(gate.pending()!.sha, 'alice (web)');
    const second = [...im.choiceMessages.values()][1]!;
    await until(() => second.outcome !== undefined);
    assert.equal(second.outcome, '✖ Cancelled: rejected by alice (web).');
  } finally {
    await bridge.stop();
  }
});

