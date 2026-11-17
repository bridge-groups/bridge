import { fileURLToPath } from 'node:url';

import { SCHEMA_FILE } from './config/json-schema.ts';

/** The bundled example agent; resolves from src/ and from the compiled out/ alike. */
const ECHO_AGENT = fileURLToPath(new URL('../src/examples/echo-agent.mjs', import.meta.url));

export const TEMPLATE = `# yaml-language-server: $schema=${SCHEMA_FILE}
# bridge config. You or a coding agent edit it; "bridge check" lists problems and what an edit changes.
# A running bridge applies edits on save; edits that widen access wait for an owner to confirm them.
version: 1

# Who is who across IMs. Routes and approvals refer to these ids.
people:
  me:
    trust: owner
    # slack: U0123456789      # your Slack member id
    # telegram: "123456789"   # your Telegram user id

# IM connections (outbound only; no public URL needed). Store tokens with:
#   bridge secret set slack_app_token
im: {}
  # slack:
  #   app_token: secret:slack_app_token   # xapp-… (Socket Mode)
  #   bot_token: secret:slack_bot_token   # xoxb-…
  # telegram:
  #   bot_token: env:TELEGRAM_BOT_TOKEN

agents:
  echo:
    type: stdio
    command: node
    args: [${JSON.stringify(ECHO_AGENT)}]
    description: replies with what you sent
  # claude-code:
  #   type: claude-code
  #   cwd: ~/code/my-app
  #   permission_mode: acceptEdits
  # data-agent:
  #   type: webhook
  #   url: http://localhost:8080/agent

# External tools (MCP servers) the bridge connects to with its own credentials.
tools: {}
  # github:                   # GitHub's hosted MCP server (remote, over HTTP)
  #   url: https://api.githubcopilot.com/mcp/
  #   headers:
  #     Authorization: "Bearer \${secret:github_token}"
  #     X-MCP-Toolsets: repos,pull_requests,issues
  # files:                    # or a local MCP server started as a child process (stdio)
  #   command: npx
  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "~/notes"]

# First match wins; anything unmatched is ignored.
routes:
  - from: local:*            # bridge chat
    when: { sender: [me] }
    to: echo
  # - from: slack:#dev
  #   when: { mention: claude-code, sender: [me] }
  #   to: claude-code
  # - from: claude-code       # what claude-code may reach
  #   to: [github.*, data-agent]

policies: []
  # - match: { tool: ["github.push*", "*.delete*"] }
  #   approve_by: [initiator]
  #   timeout: 10m
  # - match: { agent: "*" }
  #   max_hops: 4
  #   budget_usd: 2

# Assertions about the routes above, checked on every load: a file whose tests fail is not applied.
tests:
  - { from: local:dm, sender: me, expect: echo }
  - { from: local:dm, sender: stranger, expect: none }
  # - { from: slack:#random, sender: me, mention: true, expect: none }
  # - { agent: claude-code, calls: github.create_issue, expect: allow }

defaults:
  dm_idle_reset: 2h
  offline_queue_ttl: 24h
  progress: collapsed
`;
