import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ClaudeCodeAgent } from '../adapters/agent/claude-code.ts';
import { CodexAgent, unwrapShell } from '../adapters/agent/codex.ts';
import { WebhookAgent } from '../adapters/agent/webhook.ts';
import { envSecrets } from '../core/secrets.ts';
import { KILL_GRACE_MS } from '../adapters/agent/process-tree.ts';
import { StdioAgent } from '../adapters/agent/stdio.ts';
import type { AgentTurn } from '../adapters/agent/types.ts';
import { newEnvelope } from '../core/envelope.ts';
import { until } from './helpers.ts';

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function turn(text: string, extra: Partial<AgentTurn> = {}): AgentTurn {
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: 'slack:C1:T1', content: [{ type: 'text', text }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  return { envelope, text, mcp: { url: 'http://127.0.0.1:1/mcp/t', endpoint: 'http://127.0.0.1:1/mcp', token: 't' }, ...extra };
}


const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function script(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const claudeCfg = (command: string, extra: object = {}) => ({
  type: 'claude-code' as const, command, permission_mode: 'default' as const, allowed_tools: [], worktree: false,
  worktree_dir: '~/.bridge/worktrees', worktree_links: [], ...extra,
});

test('claude-code: a session is resumed in the same directory, also after its worktree was recreated', async () => {
  const bin = tmp('ab-cc-');
  const fake = script(bin, 'claude', `#!/bin/sh
cat > /dev/null
resume=none
while [ $# -gt 0 ]; do [ "$1" = "--resume" ] && resume="$2"; shift; done
printf '{"type":"result","result":"resume=%s","session_id":"S1"}\\n' "$resume"
`);
  const repo = tmp('ab-cc-repo-');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: repo, worktree: true, worktree_dir: join(repo, '..', `${repo.split('/').pop()}-wts`) }), envSecrets());

  const first = await agent.run(turn('hi'));
  assert.equal(first.text, 'resume=none');
  assert.match(first.agentSessionId!, /^S1@[0-9a-f]{12}$/);
  assert.equal((await agent.run(turn('again', { agentSessionId: first.agentSessionId }))).text, 'resume=S1');

  // Idle prune / discard removes the worktree; it comes back at the same path, so the session still applies.
  assert.match(await agent.workspace!.discard('slack:C1:T1'), /Discarded/);
  const notices: string[] = [];
  const after = await agent.run(turn('later', { agentSessionId: first.agentSessionId, onNotice: (n) => notices.push(n) }));
  assert.equal(after.text, 'resume=S1');
  assert.match(notices.join('\n'), /works on its own branch/);

  // A session from another directory is not resumed.
  assert.equal((await agent.run(turn('x', { agentSessionId: 'S1@000000000000' }))).text, 'resume=none');
});

test('claude-code: a failed run is answered with the reasons Claude Code gives, not just the subtype', async () => {
  // What `claude -p --resume <unknown id>` prints (captured from Claude Code): no `result`, the reason in `errors`.
  const fake = script(tmp('ab-cc-'), 'claude', `#!/bin/sh
cat > /dev/null
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"X","total_cost_usd":0,"errors":["No conversation found with session ID: X"]}'
`);
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }), envSecrets());
  assert.equal((await agent.run(turn('hi'))).text, '⚠️ error_during_execution: No conversation found with session ID: X');
});

test('claude-code: a process that exits without reading its prompt fails the turn instead of crashing (EPIPE)', async () => {
  const fake = script(tmp('ab-cc-'), 'claude', '#!/bin/sh\necho "bad flag" >&2\nexit 3\n');
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }), envSecrets());
  await assert.rejects(agent.run(turn('x'.repeat(4 * 1024 * 1024))), /claude exited/);
});

test('claude-code: stop and abort end the whole process group and wait for it', async () => {
  const bin = tmp('ab-cc-');
  const pidFile = join(bin, 'pid');
  const fake = script(bin, 'claude', `#!/bin/sh
sleep 1000 &
echo $! > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"
cat > /dev/null
wait
`);
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }), envSecrets());

  const running = agent.run(turn('work'));
  const outcome = running.then(() => 'resolved', (e: Error) => e.message);
  await until(() => existsSync(pidFile), 'the fake claude to start its tool');
  const tool = Number(readFileSync(pidFile, 'utf8'));
  await agent.stop();
  assert.match(await outcome, /claude exited/);
  await until(() => !alive(tool), 'the tool subprocess to be killed');

  const ac = new AbortController();
  const aborted = agent.run(turn('work', { signal: ac.signal })).then(() => 'resolved', (e: Error) => e.message);
  await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) !== tool, 'the second run to start');
  const tool2 = Number(readFileSync(pidFile, 'utf8'));
  ac.abort();
  assert.match(await aborted, /abort/i);
  await until(() => !alive(tool2), 'the aborted tool subprocess to be killed');
});

test('claude-code: a stuck process is killed after the grace period, with the commands it runs in groups of their own', async () => {
  const bin = tmp('ab-cc-');
  const pidFile = join(bin, 'pid');
  // Like Claude Code: the command runs in a process group of its own (job control). Both ignore SIGTERM.
  const fake = script(bin, 'claude', `#!/bin/bash
trap '' TERM
set -m
bash -c 'trap "" TERM; echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"; while :; do sleep 1; done' &
cat > /dev/null
wait
`);
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }), envSecrets());
  const outcome = agent.run(turn('work')).then(() => 'resolved', (e: Error) => e.message);
  await until(() => existsSync(pidFile), 'the fake claude to start its command');
  const command = Number(readFileSync(pidFile, 'utf8'));
  const started = Date.now();
  await agent.stop();
  assert.ok(Date.now() - started >= KILL_GRACE_MS - 100, 'SIGTERM alone does not end it');
  assert.match(await outcome, /claude exited/);
  assert.equal(alive(command), false, 'the command in its own process group is killed too');
});

// ───────────────────────── stdio ─────────────────────────

function stdioAgent(timeout = '30m') {
  const dir = tmp('ab-stdio-');
  const log = join(dir, 'in.log');
  writeFileSync(log, '');
  const agentScript = join(dir, 'agent.mjs');
  writeFileSync(agentScript, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const msg = JSON.parse(line);
  if (msg.type !== 'turn') return;
  if (msg.text === 'echo') out({ type: 'reply', id: msg.id, text: 'echo' });
  // anything else: never answered
});
`);
  const agent = new StdioAgent('st', { type: 'stdio', command: process.execPath, args: [agentScript], env: {}, timeout }, envSecrets());
  const received = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { agent, received };
}

test('stdio: an aborted turn is cancelled in the agent and its abort listener removed', async () => {
  const { agent, received } = stdioAgent();
  try {
    const ac = new AbortController();
    assert.equal((await agent.run(turn('echo', { signal: ac.signal }))).text, 'echo');
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'listener removed once the turn settled');

    const ac2 = new AbortController();
    const hanging = agent.run(turn('hang', { signal: ac2.signal }));
    await until(() => received().some((m) => m.text === 'hang'), 'the turn to arrive');
    ac2.abort();
    await assert.rejects(hanging, /aborted/);
    const id = received().find((m) => m.text === 'hang').id;
    await until(() => received().some((m) => m.type === 'cancel' && m.id === id), 'the cancel message');
  } finally {
    await agent.stop();
  }
});

test('stdio: a turn without a reply times out and is cancelled', async () => {
  const { agent, received } = stdioAgent('50ms');
  try {
    await assert.rejects(agent.run(turn('hang')), /gave no reply within 50ms/);
    await until(() => received().some((m) => m.type === 'cancel'), 'the cancel message');
  } finally {
    await agent.stop();
  }
});

test('stdio: an agent that closes its stdin fails the turns instead of crashing the bridge (EPIPE)', async () => {
  // Reads one turn, closes its stdin for good, keeps running.
  const agentScript = join(tmp('ab-stdio-'), 'closer.mjs');
  writeFileSync(agentScript, `
import { closeSync, readSync } from 'node:fs';
const buf = Buffer.alloc(65536);
let s = '';
while (!s.includes('\\n')) {
  const n = readSync(0, buf);
  if (!n) break;
  s += buf.toString('utf8', 0, n);
}
closeSync(0);
const { id } = JSON.parse(s.split('\\n')[0]);
process.stdout.write(JSON.stringify({ type: 'progress', id, text: 'closed' }) + '\\n');
setInterval(() => {}, 1000);
`);
  const agent = new StdioAgent('st', { type: 'stdio', command: process.execPath, args: [agentScript], env: {}, timeout: '30m' }, envSecrets());
  try {
    let closed!: () => void;
    const isClosed = new Promise<void>((r) => (closed = r));
    const first = agent.run(turn('close-stdin', { onProgress: () => closed() }));
    const firstOutcome = first.then(() => 'resolved', (e: Error) => e.message);
    await isClosed;
    const second = agent.run(turn('after')).then(() => 'resolved', (e: Error) => e.message);
    assert.match(await second, /stopped reading its input|exited/);
    assert.match(await firstOutcome, /stopped reading its input|exited/);
  } finally {
    await agent.stop();
  }
});

// ───────────────────────── codex ─────────────────────────

const codexCfg = (command: string, extra: object = {}) => ({
  type: 'codex' as const, command, sandbox: 'workspace-write' as const, worktree: false,
  worktree_dir: '~/.bridge/worktrees', worktree_links: [], ...extra,
});

/** A fake `codex` that records how it was run and answers with the events in $CODEX_SCRIPT (one JSON per line). */
function fakeCodex() {
  const bin = tmp('ab-codex-');
  const log = join(bin, 'runs.jsonl');
  const fake = script(bin, 'codex', `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const stdin = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, token: process.env.BRIDGE_MCP_TOKEN }) + '\\n');
const mode = stdin.includes('FAIL') ? 'fail' : stdin.includes('CRASH') ? 'crash' : 'ok';
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
out({ type: 'thread.started', thread_id: 'T-123' });
out({ type: 'turn.started' });
if (mode === 'crash') { out({ type: 'error', message: 'stream disconnected' }); process.exit(1); }
out({ type: 'item.completed', item: { type: 'agent_message', text: 'Looking.' } });
out({ type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'git status'" } });
out({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'bridge', tool: 'send_message' } });
out({ type: 'item.started', item: { type: 'file_change', changes: [{ path: 'src/a.ts' }] } });
if (mode === 'fail') out({ type: 'turn.failed', error: { message: 'usage limit reached' } });
else { out({ type: 'item.completed', item: { type: 'agent_message', text: 'All done.' } }); out({ type: 'turn.completed', usage: {} }); }
`);
  const runs = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string; token?: string });
  return { fake, runs };
}

test('codex: runs codex exec with the bridge as an MCP server, reports progress, and resumes its thread', async () => {
  const { fake, runs } = fakeCodex();
  const cwd = tmp('ab-codex-cwd-');
  const agent = new CodexAgent('cx', codexCfg(fake, { cwd, model: 'gpt-x', sandbox: 'read-only' }), envSecrets());
  const steps: string[] = [];
  const ids: string[] = [];
  const t = turn('fix it', {
    mcp: { url: 'http://127.0.0.1:1/mcp/SECRET-TOKEN', endpoint: 'http://127.0.0.1:1/mcp', token: 'SECRET-TOKEN' },
    files: [{ name: 'shot.png', path: '/tmp/in/shot.png', mime: 'image/png' }, { name: 'log.txt', path: '/tmp/in/log.txt' }],
    onProgress: (s) => steps.push(s),
    onSessionId: (id) => ids.push(id),
  });
  const first = await agent.run(t);
  assert.equal(first.text, 'All done.', 'the last message is the answer');
  assert.equal(first.costUsd, undefined, 'codex reports tokens, not dollars');
  assert.match(first.agentSessionId!, /^T-123@[0-9a-f]{12}$/);
  assert.deepEqual(ids, [first.agentSessionId]);
  assert.deepEqual(steps, ['Run git status', 'send_message', 'Edit src/a.ts']);

  const run = runs()[0]!;
  const config = (key: string) => {
    const i = run.argv.findIndex((a, j) => run.argv[j - 1] === '-c' && a.startsWith(`${key}=`));
    assert.ok(i > 0, `-c ${key}`);
    return JSON.parse(run.argv[i]!.slice(key.length + 1));
  };
  assert.deepEqual(run.argv.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  assert.equal(config('approval_policy'), 'never');
  assert.equal(config('sandbox_mode'), 'read-only');
  assert.equal(config('mcp_servers.bridge.url'), 'http://127.0.0.1:1/mcp');
  assert.equal(config('mcp_servers.bridge.bearer_token_env_var'), 'BRIDGE_MCP_TOKEN');
  assert.match(config('developer_instructions'), /reached through bridge/);
  assert.equal(run.token, 'SECRET-TOKEN', 'the token comes in the environment…');
  assert.ok(!run.argv.join(' ').includes('SECRET-TOKEN'), '…never on the command line');
  assert.deepEqual(run.argv.slice(run.argv.indexOf('--model'), run.argv.indexOf('--model') + 2), ['--model', 'gpt-x']);
  assert.deepEqual(run.argv.filter((_, i) => run.argv[i - 1] === '--image'), ['/tmp/in/shot.png']);
  assert.equal(run.argv.at(-1), '-');
  assert.match(run.stdin, /^fix it\n\n\[Attached by the person.*\n- \/tmp\/in\/shot\.png .*\n- \/tmp\/in\/log\.txt/);

  await agent.run(turn('again', { agentSessionId: first.agentSessionId }));
  assert.deepEqual(runs()[1]!.argv.slice(0, 4), ['exec', 'resume', 'T-123', '--json']);
});

test('codex: progress shows the command inside the shell Codex wraps it in', () => {
  assert.equal(unwrapShell("/bin/zsh -lc 'git log -1'"), 'git log -1');
  assert.equal(unwrapShell('/bin/zsh -lc ls'), 'ls');
  assert.equal(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(unwrapShell('python3 x.py'), 'python3 x.py');
});

test('codex: a failed turn is answered with the reason; a crash fails the turn with its error', async () => {
  const { fake } = fakeCodex();
  const agent = new CodexAgent('cx', codexCfg(fake, { cwd: tmpdir() }), envSecrets());
  assert.equal((await agent.run(turn('FAIL'))).text, '⚠️ usage limit reached');
  await assert.rejects(agent.run(turn('CRASH')), /codex exited: stream disconnected/);
});

// ───────────────────────── webhook ─────────────────────────

/** A webhook agent served by `respond`; resolves the agent and a way to close the server. */
async function webhookAgent(respond: (res: import('node:http').ServerResponse, body: any) => void) {
  const server = createServer((req, res) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => respond(res, JSON.parse(s)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/agent`;
  const agent = new WebhookAgent('wh', { type: 'webhook', url, headers: {}, timeout: '1m' }, envSecrets());
  return {
    agent,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('webhook: an event stream reports progress and the session id before the reply', async () => {
  const { agent, close } = await webhookAgent((res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Events split across writes, CRLF line ends, a comment, a multi-line data field and an unknown type.
    res.write(': keep-alive\r\n\r\ndata: {"type":"progress",');
    res.write('"text":"Reading logs"}\r\n\r\nevent: x\ndata: {"type":"session","session_id":"W1"}\n\n');
    res.write('data: {"type":"future"}\n\n');
    res.end(`data: {"type":"reply",\ndata: "text":"done: ${body.text}","cost_usd":0.5}\n\n`);
  });
  try {
    const steps: string[] = [];
    const ids: string[] = [];
    const reply = await agent.run(turn('hello', { onProgress: (s) => steps.push(s), onSessionId: (id) => ids.push(id) }));
    assert.deepEqual(reply, { text: 'done: hello', agentSessionId: 'W1', costUsd: 0.5 });
    assert.deepEqual(steps, ['Reading logs']);
    assert.deepEqual(ids, ['W1']);
  } finally {
    await close();
  }
});

test('webhook: a stream that fails or ends without a reply fails the turn; plain JSON still works', async () => {
  let mode = '';
  const { agent, close } = await webhookAgent((res) => {
    if (mode === 'json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"text":"plain"}');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (mode === 'error') res.end('data: {"type":"progress","text":"x"}\n\ndata: {"type":"error","message":"model overloaded"}\n\n');
    else res.end('data: {"type":"progress","text":"x"}\n\n');
  });
  try {
    mode = 'error';
    await assert.rejects(agent.run(turn('x')), /wh: model overloaded/);
    mode = 'cut';
    await assert.rejects(agent.run(turn('x')), /ended without a reply/);
    mode = 'json';
    assert.equal((await agent.run(turn('x'))).text, 'plain');
  } finally {
    await close();
  }
});

test('webhook: stopping a turn closes its event stream', async () => {
  let closed!: () => void;
  const streamClosed = new Promise<void>((r) => (closed = r));
  const { agent, close } = await webhookAgent((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"progress","text":"working"}\n\n');
    res.on('close', () => closed());
  });
  try {
    const ac = new AbortController();
    const running = agent.run(turn('x', { signal: ac.signal, onProgress: () => ac.abort() }));
    await assert.rejects(running, /abort/i);
    await streamClosed;
  } finally {
    await close();
  }
});
