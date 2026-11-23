# Bridge

Connects **Agents ↔ IM**, **Agents ↔ Agents** and **Agents ↔ Tools**. Chat messages from Slack, Feishu / Lark,
Discord or Telegram reach agents such as Claude Code or Codex; each agent turn can post updates, ask a person, hand work to
another agent and call the tool servers its routes allow; policies decide approvals and budgets; everything lands
in an audit trail with secrets redacted.

- **IM**: Slack (Socket Mode) and Feishu / Lark (long connection), both outbound, so you need no public URL.
  Discord (Gateway WebSocket) and Telegram (long polling) are written but not yet tested against the real services.
- **Tools**: MCP servers, local or remote. The bridge holds the credentials and gives each agent only what its
  routes allow.
- **Agents**: Claude Code (`claude -p`), Codex (`codex exec`), any HTTP webhook, remote agents speaking A2A, or any
  local process speaking JSON lines ([doc/agents.md](doc/agents.md)).
- **Deny by default**: a message reaches an agent only through a route, and every message, tool call and approval
  is recorded.

This README is about the `bridge` command, for your own machine: one process, one `bridge.yaml`, secrets in the OS
keychain, a local dashboard. To embed the bridge in an app or service instead, use the library
`@bridge-groups/bridge` ([doc/embeds.md](doc/embeds.md)).

## Quick start

Needs Node 24 or later.

```bash
npm install && npm run output && npm link  # puts `bridge` on your PATH
bridge init              # writes ~/.config/bridge/bridge.yaml with a local echo agent
bridge check             # problems with line numbers, the file's tests, what an edit changes
bridge chat --as me      # talk to your routes from the terminal
```

Then add an IM, a real agent and a tool server:

```yaml
people:
  alice: { trust: owner, slack: U0123456789 }
im:
  slack: { app_token: secret:slack_app_token, bot_token: secret:slack_bot_token }
agents:
  claude-code: { type: claude-code, cwd: ~/code/app, permission_mode: acceptEdits }
  data-agent:  { type: webhook, url: http://localhost:8080/agent }
tools:
  github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${secret:github_token}" } }
routes:
  - { from: slack:#dev, when: { sender: [alice] }, to: claude-code }
  - { from: slack:#data, to: data-agent }
  - { from: claude-code, to: [github.*, data-agent] }
policies:
  - { match: { tool: "github.*", writes: true }, approve_by: [initiator] }   # every GitHub tool not marked read-only
  - { match: { agent: "*" }, budget_usd: 2 }
```

```bash
bridge secret set slack_app_token   # macOS keychain; elsewhere export BRIDGE_SECRET_SLACK_APP_TOKEN
bridge doctor                       # config, secrets, agents and tool servers (and IM connections, when running)
bridge up
```

## Where things are

| What | Where |
| --- | --- |
| The config | `~/.config/bridge/bridge.yaml` (`$XDG_CONFIG_HOME/bridge/` when set); `-c <path>` names another |
| Your data: conversations and the audit trail (`bridge.db`), the config applied last (`applied/`), conversation worktrees (`worktrees/`) | `~/.bridge` (`server.data_dir` and `worktree_dir` move the first and last) |
| Temporary files: attachments and agents' scratch files, readable by you only | `/tmp/bridge` |
| Secrets and OAuth tokens | the macOS keychain, service `dev.bridge` |
| The background service's log | `~/Library/Logs/bridge/bridge.log` |

`bridge` with no arguments prints these paths too.

## Changing bridge.yaml

You, or a coding agent, edit the file; a running bridge applies it on save. Edits that widen access (a new route or
person, a changed command, a removed policy) wait until an owner confirms them: Apply / Reject in each owner's DM
with the bot, on the dashboard, or `bridge check --apply` on this machine. Routing rules, policies, what counts as
widening, and the `tests` a file can carry are in [doc/config.md](doc/config.md).

An agent whose settings changed gets a new process for its next turn; turns already running finish on the old one.
Changing IM credentials needs a restart.

### When an IM can't connect

One IM failing to connect (a refused app secret, no network yet) doesn't stop the others: the bridge keeps running
and tries that IM again after 1 minute, then at doubling intervals up to every 30 minutes. Its conversations,
including work queued from the last run, wait until it is back (still within `offline_queue_ttl`). You see why it is
down, without the secret, in `bridge status`, `bridge doctor`, on the dashboard, and in a DM on an IM that works
(once per outage, and again when it is back; owners only, if they have a DM with the bot). Retries reuse the
credential read at start, so after fixing a secret run `bridge service restart`. If every IM is down, the bridge
still runs, so the dashboard can tell you why.

An IM that drops after connecting reconnects on its own. Where the bridge sees the drop (Discord's gateway), the IM
shows as `reconnecting` with the reason in the same places: nothing arrives meanwhile, but replies still go out.
Owners get a DM if it lasts over 5 minutes (and again when it is back), and whenever messages sent meanwhile may be
lost for good (Discord could not resume the session), so they can be sent again. Each drop and reconnect is logged.

## IM

- **Slack**: `bridge slack manifest` prints the app manifest (the app is named "Bridge"); paste it at
  api.slack.com/apps → From a manifest. Store the app-level token (`xapp-…`) and the bot token (`xoxb-…`) with
  `bridge secret set`.
- **Feishu / Lark**: `bridge feishu setup` lists the app's features, the scopes to import, and the events and
  callbacks to subscribe. Replies are message cards; headings and tables are rewritten for card markdown. People are
  mapped by open_id (`people: { alice: { feishu: ou_xxx } }`); `bridge up` prints the open_id of anyone it ignores.
- **Discord**: `bridge discord setup [application id]` lists the steps in the Developer Portal and prints the invite
  link with the permissions the bot needs. Each conversation in a channel is a thread opened from its first
  message; DMs are plain. People are mapped by user id (`people: { alice: { discord: "123…" } }`). Without
  `message_content: true` (a privileged intent to switch on in the portal) the bot only reads DMs, mentions and
  replies to it, so follow-ups in a thread mention it too, and `mention: false` routes are refused; the first message
  in a conversation thread that arrives blank for this reason gets a one-time hint saying so. Discord's @ list also
  offers the bot's role, under the same name: a message that mentions the role instead of the app is answered with a
  note to pick the entry marked APP, and isn't read. Every message the bot ignores is logged with why. What agents write
  pings nobody. A gateway connection that hasn't completed its handshake within 30 seconds (a stalled proxy, say) is
  dropped and tried again.

Approvals and confirmations are buttons where the IM has them; typing `approve` / `deny` / `yes` also works.
Progress shows in a placeholder message that is edited as the agent works (`defaults.progress`: `collapsed`,
`verbose` or `off`).

Files and images sent with a message are downloaded to `/tmp/bridge/files/<conversation>/` (up to `max_file_mb`,
default 20) and handed to the agent as local paths (A2A agents get their contents). Slack needs the `files:read` scope.

## Agents

- **claude-code** runs `claude -p` per turn and resumes the conversation's Claude session. `permission_mode` and
  `allowed_tools` decide what it may do without asking.
- **codex** runs `codex exec --json` per turn and resumes the conversation's Codex session. `sandbox`
  (`read-only`, `workspace-write` (default: write in the working directory, no network) or `danger-full-access`)
  bounds its commands; nobody is asked to approve one, so what the sandbox refuses fails. It uses your own
  `~/.codex` login and config.
- **webhook** and **stdio** agents speak the protocol in [doc/agents.md](doc/agents.md); see
  [src/examples/echo-agent.mjs](src/examples/echo-agent.mjs).
- **a2a** reaches a remote agent speaking [A2A](https://a2a-protocol.org) 1.0 or 0.3: `url` points at its agent card,
  `headers` carry its credentials, and each conversation is one A2A context. See
  [doc/agents.md](doc/agents.md#a2a-agents).

A tool call that waits for a person (`ask_human`, an approval) or another agent (`delegate`) may take up to a day:
`claude-code` and `codex` agents are told to allow one call to the bridge 24 hours and a minute instead of their
default 60 seconds. A longer approval `timeout` or delegated turn ends at that bound.

A `budget_usd` policy caps what a conversation may spend: each turn starts with only what is left (Claude Code gets
it as `--max-budget-usd`), and a turn starts only when that covers the agent's cheapest recent turn. Codex reports
tokens, not dollars, so budgets don't limit `codex` agents.

When a turn is stopped or the bridge shuts down, the agent and the commands it runs get SIGTERM and, 5 seconds later,
SIGKILL (a process an agent deliberately detached, such as `nohup … &`, is not tracked). A turn cut off by a restart
resumes in the same agent session, at most twice.

### A branch per conversation

With `worktree: true` on a `claude-code` or `codex` agent (git 2.38 or later), each conversation gets its own git
worktree under `worktree_dir` on branch `bridge/<conversation>`, so two threads never edit the same checkout.
`worktree_links` links untracked things like `node_modules` from the main checkout (and excludes them from git).

Finish a conversation's branch from the thread itself, with a message that is exactly the word:

| say | does |
|---|---|
| `status` / `状态` | branch, commits not yet in the base branch, diffstat, uncommitted files |
| `merge` / `合并` | shows what would land, then on `yes` squashes the branch into its base in your main checkout as one commit and removes the worktree |
| `discard` / `丢弃` | removes the worktree and branch (asks first if that would lose commits or changes) |
| `pr` / `开pr` | pushes the branch to `origin` and opens a pull request into the base (or reports the open one); needs `git_token` on the agent |

The base is whatever the main checkout had checked out when the conversation started; merge requires the main
checkout to be on that branch with no uncommitted changes. The squash commit is built without touching the checkout
and then fast-forwarded, so a conflict or a failing commit (signing, identity) changes nothing; commit hooks don't
run again for it. Merge and `pr` refuse a branch that changes a linked path or a path your main checkout ignores. If
the base branch was deleted or renamed, commits are counted from where the branch started; when even that is
unknown, the branch is never pruned and `discard` asks first.

`bridge worktrees` lists every conversation branch with its unmerged work; `bridge worktrees prune` removes the ones
idle for `--older-than` (default 7d) with nothing unmerged, and `--force` removes them even with unmerged work.

## Tool servers

- **Local** (`command`, `args`, `env`): the bridge starts the MCP server and talks stdio. The child gets a minimal
  environment plus its own `env`, never the bridge's secrets.
- **Remote** (`url`, `headers`): Streamable HTTP, falling back to the older SSE transport
  (`transport: auto | streamable-http | sse`). A header value can be a whole secret reference (`secret:x`, `env:X`)
  or contain `${secret:x}` / `${env:X}`.
- **OAuth** (`url`, `oauth: true`): run `bridge auth <server>` once, or press **Connect** on the dashboard. The
  browser comes back to `http://127.0.0.1:7377/oauth/callback`; the bridge registers itself (dynamic client
  registration), uses PKCE, keeps the tokens in the keychain and refreshes them. A tool call never opens a browser.
  Providers without dynamic registration need a registered app:
  `oauth: { client_id: …, client_secret: secret:…, scopes: [...] }`. `bridge auth` lists sign-in state;
  `--sign-out` forgets the tokens.

`timeout` (default `5m`) bounds one tool call; progress notifications from the server extend it. A dropped
connection is reconnected: read-only tools are retried, and a tool that may write is retried only if the request
never reached the server, so a write never runs twice.

## Running in the background (macOS)

```bash
bridge service install    # LaunchAgent: starts at login, restarted if it exits
bridge service restart    # after rebuilding (npm run output)
bridge service status
bridge service uninstall
```

Logs go to `~/Library/Logs/bridge/bridge.log`, each line starting with its ISO-8601 time (UTC): `bridge up` stamps
every line whenever its output is not a terminal, so a log redirected to a file gets them too. The service starts
with a bare environment, so `install` refuses a config that uses `env:` references or names secrets missing from the
keychain. Messages already queued when the bridge stops run when it is back, within `offline_queue_ttl` (default
24h); older ones are dropped and their thread is told so. Messages sent while it is not running reach it afterwards
only on Telegram: Slack, Feishu / Lark and Discord drop them, so after a restart the owners get a DM saying how long
the bridge was away and to resend anything unanswered.

Housekeeping runs a minute after start and then every 6 hours. It deletes:
- attachments older than `files_ttl` (default 7d);
- idle conversation worktrees with nothing unmerged, after `worktree_prune_after` (default 7d, `off` keeps them);
- audit-trail entries older than `retention`, and conversations idle that long (default 30d, `off` keeps them). A
  deleted conversation starts afresh, with a fresh budget.

## Dashboard

`bridge dashboard` opens `http://127.0.0.1:7377/`, served by the running bridge to this machine only:

- **IM not connected**: an IM that failed to connect, why, and when it is tried next; or one that is reconnecting
  and receives nothing meanwhile.
- **Waiting for you**: pending approvals, confirmations and config changes. You decide as the config's first owner.
- **Conversations**: each with its agent, cost, activity and branch; merge or discard a branch (it shows what will
  happen first, waits for any running turn, and posts the result to the thread).
- **Activity**: the audit trail, for everything or one conversation, with every tool argument in full.
- **Tool servers**: reachable or not, tool counts, OAuth Connect / Sign out.

Writes must be same-origin JSON and requests must carry a loopback `Host`, so other web pages and DNS-rebinding
tricks can't drive it. `bridge status`, `bridge sessions` and `bridge trace` show the same from the terminal.

## Not in v0.1 yet

- Discord and Telegram tested against the real services
- An A2A server: bridge agents reachable by other A2A clients (the bridge is an A2A client today)
- A spending limit per sender outside `people:` (today the budget is per conversation, so a new thread starts a
  fresh one)
- A hosted service built on the library: one bridge per user, Slack apps installed into many workspaces over HTTP
  events, per-user isolation and limits, agents that run user code in sandboxes

## Not planned

- Commands that edit `bridge.yaml`: you or a coding agent edit the file directly.
- A cloud relay, or bridges on several machines sharing one bot: the `bridge` command runs on your own machine.

Contributing: see [AGENTS.md](AGENTS.md).
