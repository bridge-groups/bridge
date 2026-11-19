# Using bridge as a library

`@bridge-groups/bridge` is the bridge without the CLI: routing, policies, sessions, the audit trail, per-turn MCP
endpoints, budgets, IM adapters and remote agents. An app or service embeds it and keeps users' configuration and
secrets itself. The `bridge` command is one such app, for your own machine.

| Entry point | What it holds |
| --- | --- |
| `@bridge-groups/bridge` | `Bridge`, config parsing and checks (`parseConfig`, `checkConfig`, `configChanges`), `SqliteStore` and the `BridgeStore` interface, `Redactor`, `envSecrets`, IM adapters (Slack, Feishu / Lark, Telegram), `WebhookAgent`, `ToolHub`, OAuth storage |
| `@bridge-groups/bridge/local` | `localAgents`: Claude Code and Codex (with git worktrees) and stdio agents, which run code on this machine; `LocalConsoleAdapter` |

Nothing in the main entry point reads a config file, the OS keychain or the CLI's dashboard; a test keeps it that
way. Agents the app runs itself speak the protocol in [agents.md](agents.md).

## Embedding

```ts
import { Bridge, parseConfig, SqliteStore, SlackAdapter, Redactor } from '@bridge-groups/bridge';

const redactor = new Redactor();
const secret = (ref: string) => vault.resolve(userId, ref); // your secret store: secret:x, env:X, or a literal
const appToken = secret('secret:slack_app'), botToken = secret('secret:slack_bot');
redactor.add(appToken);
redactor.add(botToken);

const bridge = new Bridge({
  cfg: parseConfig(userConfigYaml),              // or a BridgeConfig object; checkConfig() reports problems with lines
  secrets: secret,                               // resolves references in the config (headers, env, OAuth clients)
  redactor,                                      // secrets resolved outside the bridge, kept out of the trail
  store: new SqliteStore(`/data/${userId}.db`),  // or your own BridgeStore
  ims: [new SlackAdapter({ appToken, botToken })],
  mcpBaseUrl: `https://app.example.com/bridge/${userId}`,
});

// On your HTTP server: the bridge answers its own paths under mcpBaseUrl and resolves false for anything else.
server.on('request', async (req, res) => {
  if (await bridge.handle(req, res)) return;
  // …your routes
});
await bridge.start();
```

- **Paths.** Under `mcpBaseUrl` the bridge serves `/mcp/<token>` (or `/mcp` with the token as a bearer), one
  endpoint per agent turn, and `/oauth/callback`. Starting an OAuth sign-in is not an HTTP route: call
  `bridge.oauth.start(server)` behind your own authentication and send the user to the URL it returns. Without
  `mcpBaseUrl` the bridge listens on `cfg.server.host:port` itself; `extraRoutes` adds routes there.
- **Secrets.** `secrets` resolves every `secret:` / `env:` reference the bridge meets (default: `envSecrets()`,
  the environment only). Every value it returns is redacted from that bridge's audit trail.
- **Agents.** By default only remote agents (`webhook`, `a2a`) are built from the config. Pass
  `agentFactory: localAgents` from `/local` to run Claude Code, Codex and stdio agents on the host. A service running
  other people's bridges should not, or should run each bridge in its own sandbox. `agents` takes adapters you
  build yourself (any `AgentAdapter`).
- **Store.** `BridgeStore` holds conversations, the inbound queue (turns resume after a restart) and the audit
  trail. Its methods may return promises, so it can live in your database; `SqliteStore` is the default. A
  conversation records the agent holding it; each agent's own session id in it is kept apart (`agentSession`, and
  `updateSession` with `agentSession`), so switching agents and back resumes each one's session. `deleteSession` and
  `prune` remove those ids with their conversation.
- **Temporary files.** Attachments and agents' scratch files go under `tempDir` (default: `bridge` in the OS temp
  folder), which the bridge keeps readable by this user only.
- **OAuth.** Tokens for tool servers that sign in with OAuth go to `oauthStorage` (default: memory, lost on
  restart).
- **Config changes.** `bridge.reload(cfg)` applies a new config without dropping IM connections. To hold back
  changes that widen access, as the CLI does, compare with `configChanges(running, next)`: entries with `widens`
  need someone's confirmation. `bridge.askInDms` asks people in their DMs with the bot, with buttons.
- **Log.** `log(line, level)` receives what the bridge reports; `error` marks failures someone should look at
  (default: the console).

## Showing a bridge in your app

These methods are what the CLI's dashboard is built on:

| Method | Gives |
| --- | --- |
| `status()` | IMs, agents, tools, running turns |
| `sessions()` | conversations with agent, cost, activity, and branch status where the agent keeps branches |
| `auditTrail({ sessionKey?, limit })` | the audit trail, newest first, secrets redacted |
| `pendingChoices()` / `decide(id, value, person, via)` | approvals and confirmations waiting, and deciding one as a person from `people` |
| `branchAction(key, 'merge' \| 'discard', { preview?, person, via })` | merge or discard a conversation's branch, or say what that would do |
| `toolServers()` | each tool server, whether it answers, its tool count and OAuth state |

`person` (an id from `people`) is who acts, and `via` (for example `"web"`) where; both go into the audit trail.
`decide` refuses a person the choice doesn't allow; `branchAction` trusts the app to have checked who may act.

## Several users

Give each user their own `Bridge`: instances share nothing (store, secrets, redaction, MCP grants). Mount them under
different `mcpBaseUrl` paths of one server. When one bot serves many users, implement an `ImAdapter` that receives
the platform's events once and hands each message to the right user's bridge.
