import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge, parseConfig, SqliteStore, type AgentAdapter, type SecretResolver } from '../index.ts';
import { FakeIm } from './helpers.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module a file loads at run time (type-only imports are erased and don't count), transitively. */
function runtimeGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'(\.[^']+\.ts)';/gm)) {
      visit(join(dirname(file), m[1]!));
    }
  };
  visit(join(SRC, entry));
  return new Set([...seen].map((f) => relative(SRC, f)));
}

test('library: the lib entry point never loads the CLI, the keychain, the dashboard or local agents', () => {
  const lib = runtimeGraph('index.ts');
  const cliOnly = [
    'cli.ts', 'secrets.ts', 'keychain-oauth.ts', 'service.ts', 'template.ts', 'config/gate.ts',
    'web/api.ts', 'web/page.ts',
    'adapters/agent/local.ts', 'adapters/agent/cli-agent.ts', 'adapters/agent/claude-code.ts', 'adapters/agent/codex.ts',
    'adapters/agent/stdio.ts', 'adapters/agent/worktree.ts',
  ];
  assert.deepEqual(cliOnly.filter((f) => lib.has(f)), []);
  assert.ok(lib.has('core/bridge.ts') && lib.has('adapters/im/slack.ts'));
  // The opt-in entry point is where local agents come from.
  const local = runtimeGraph('local.ts');
  assert.ok(local.has('adapters/agent/claude-code.ts') && local.has('adapters/agent/codex.ts'));
});

const tenantConfig = `
people: { owner: { trust: owner, slack: U1 } }
im: { slack: { app_token: secret:app, bot_token: secret:bot } }
agents:
  helper: { type: webhook, url: "http://127.0.0.1:9/agent" }
  local: { type: stdio, command: "true" }
tools:
  crm: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer \${secret:crm}" } }
routes:
  - { from: "slack:#dev", when: { sender: [owner] }, to: helper }
  - { from: "slack:#ops", when: { sender: [owner] }, to: local }
  - { from: helper, to: ["crm.*"] }
`;

test('library: bridges for several users share one HTTP server, each with its own secrets and audit trail', async () => {
  const app = createServer(async (req, res) => {
    for (const b of bridges) if (await b.handle(req, res)) return;
    res.writeHead(200).end('the app'); // anything else is the app's own
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const port = (app.address() as { port: number }).port;

  const tenants = ['alice', 'bob'];
  const ims = tenants.map(() => new FakeIm());
  const stores = tenants.map(() => new SqliteStore(':memory:'));
  const seenUrls: string[] = [];
  // The agent lists its tools over MCP, then mentions both tenants' CRM tokens in its reply.
  const helper: AgentAdapter = {
    name: 'helper',
    async run(turn) {
      seenUrls.push(turn.mcp.url);
      const client = new Client({ name: 'helper', version: '0' });
      // Alice's agent sends the token as a header to the shared endpoint; Bob's has it in the URL.
      const viaHeader = turn.mcp.url.includes('/u/alice/');
      const transport = viaHeader
        ? new StreamableHTTPClientTransport(new URL(turn.mcp.endpoint), { requestInit: { headers: { Authorization: `Bearer ${turn.mcp.token}` } } })
        : new StreamableHTTPClientTransport(new URL(turn.mcp.url));
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        return { text: `tools: ${tools.map((t) => t.name).sort().join(',')} | crm-token-alice-0001 crm-token-bob-00002` };
      } finally {
        await client.close();
      }
    },
  };
  const vault: Record<string, Record<string, string>> = {
    alice: { app: 'xapp-alice', bot: 'xoxb-alice', crm: 'crm-token-alice-0001' },
    bob: { app: 'xapp-bob', bot: 'xoxb-bob', crm: 'crm-token-bob-00002' },
  };
  const secretsOf = (tenant: string): SecretResolver => (ref) => {
    if (!ref.startsWith('secret:')) return ref;
    const v = vault[tenant]![ref.slice(7)];
    if (!v) throw new Error(`no ${ref}`);
    return v;
  };
  const bridges = tenants.map(
    (t, i) =>
      new Bridge({
        cfg: parseConfig(tenantConfig),
        store: stores[i]!,
        ims: [ims[i]!],
        secrets: secretsOf(t),
        agents: new Map([['helper', helper]]),
        mcpBaseUrl: `http://127.0.0.1:${port}/u/${t}`,
        log: () => {},
      }),
  );
  try {
    for (const b of bridges) assert.match((await b.start()).mcpUrl, /\/u\/(alice|bob)$/);
    ims[0]!.receive({ userId: 'U1', text: 'hi', channelName: 'dev' });
    ims[1]!.receive({ userId: 'U1', text: 'hi', channelName: 'dev' });
    for (const b of bridges) await b.idle();

    assert.ok(seenUrls[0]!.startsWith(`http://127.0.0.1:${port}/u/`), 'agents reach the bridge where the app mounted it');
    for (const im of ims) assert.ok(im.transcript().some((t) => t.startsWith('tools: ')), im.transcript().join('\n'));
    // Each bridge redacts the secrets it resolved itself, and only those.
    const replies = await Promise.all(stores.map(async (s) => (await s.readTrace()).find((r) => r.kind === 'reply')!.detail));
    assert.match(replies[0]!, /\[redacted\] crm-token-bob-00002/);
    assert.match(replies[1]!, /crm-token-alice-0001 \[redacted\]/);

    // Not the bridge's path: the app answers.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/u/alice/other`)).text(), 'the app');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/elsewhere`)).text(), 'the app');
    assert.equal((await fetch(`http://127.0.0.1:${port}/u/alice/mcp/not-a-token`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/u/alice/mcp`, { method: 'POST' })).status, 401);
    const stale = { method: 'POST', headers: { authorization: 'Bearer not-a-token' } };
    assert.equal((await fetch(`http://127.0.0.1:${port}/u/alice/mcp`, stale)).status, 401);

    // Without the local agents factory, an agent that would run on this machine is refused.
    ims[0]!.receive({ userId: 'U1', text: 'hi', channelName: 'ops' });
    await bridges[0]!.idle();
    assert.match(ims[0]!.transcript().join('\n'), /runs on this machine — enable local agents/);
  } finally {
    for (const b of bridges) await b.stop();
    app.closeAllConnections(); // fetch keeps connections alive
    await new Promise<void>((r) => app.close(() => r()));
  }
});
