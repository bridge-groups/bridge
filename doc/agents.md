# Writing an agent

An agent is anything that takes a turn (a message and its context) and returns a reply. Claude Code and Codex are
built in; any other agent is a **webhook** (an HTTP service), a **stdio** process (a long-running local program), or
an **A2A** agent (a remote service speaking the Agent2Agent protocol, below).

## What every turn gets

Each turn has its own MCP endpoint, valid until the turn ends. Its URL carries a token (`<base>/mcp/<token>`);
clients told the URL on a command line can use `<base>/mcp` with `Authorization: Bearer <token>` instead. The
endpoint offers:

| tool | what it does |
|---|---|
| `send_message` | post an interim update to the thread being answered (only that thread) |
| `ask_human` | ask the initiator a question in the thread and wait for the reply |
| `delegate` | hand a task to another agent the routes allow; trust drops to `agent`, hops +1 |
| `<server>__<tool>` | a tool of a tool server the routes allow, after approval where a policy requires it |

A call can wait a long time: `ask_human` up to a day, an approval as long as its policy's `timeout`, `delegate` until
the other agent's turn ends. MCP clients often give up much sooner (Claude Code and Codex after 60 seconds by
default), so the bridge raises the limit for its built-in agents to 24 hours and a minute per call (`timeout` in
Claude Code's MCP config, `tool_timeout_sec` for Codex); a wait longer than that ends there. A webhook or stdio agent
that calls these tools should let its MCP client wait as long.

## Messages

Both kinds of agent exchange the same JSON messages ([protocol.ts](../src/adapters/agent/protocol.ts)):

- **bridge → agent**: `{"type":"turn","text","session_id","budget_usd","files","envelope","mcp":{"url"}}`.
  - `session_id` is what the agent returned last time in this conversation, or null.
  - `budget_usd` is what is left of the conversation's budget, or null when there is none.
  - `files` are attachments as local paths.
- **agent → bridge**:
  - `{"type":"progress","text"}`: a short step, shown in the thread's progress message.
  - `{"type":"session","session_id"}`: the agent's own session id, as soon as it is known, so a turn cut off by a
    restart resumes in it.
  - `{"type":"reply","text","session_id"?,"cost_usd"?}`: the answer; it ends the turn.
  - `{"type":"error","message"}`: the turn failed.

Message types the bridge doesn't know are ignored, so an agent can send newer ones.

### Webhook

`POST <url>` with the turn message (plus the agent's `headers`). Answer with the reply as JSON
(`{"text","session_id"?,"cost_usd"?}`), or with `text/event-stream` to report progress while working: each event's
`data` is one agent message, ending with a reply or an error. The agent's `timeout` (default `10m`) covers the whole
request; stopping the turn closes it.

### stdio

The bridge starts `command` once and writes one turn message per line, each with an `id`; the agent answers with
lines carrying the same `id`, and may work on several turns at once. When a turn is stopped or gets no reply within
the agent's `timeout` (default `30m`), the bridge writes `{"type":"cancel","id"}` and ignores anything that comes
back for that id. Lines that aren't JSON are ignored, and stderr goes to the bridge's log. See
[src/examples/echo-agent.mjs](../src/examples/echo-agent.mjs).

## A2A agents

`type: a2a` reaches an agent that speaks [A2A](https://a2a-protocol.org) 1.0 or 0.3 over JSON-RPC
([a2a.ts](../src/adapters/agent/a2a.ts)). It speaks A2A instead of the messages above, so it gets no MCP endpoint:
it can't call `send_message`, `ask_human`, `delegate` or tool servers, but routes and other agents' `delegate` reach
it like any agent.

- **Agent card.** `url` is the card's URL, or the URL it lives under (`/.well-known/agent-card.json` is added unless
  `url` ends in `.json`). The bridge reads the card on the agent's first turn and again after a failed turn, and
  takes its JSON-RPC interface, preferring 1.0 over 0.3, and `capabilities.streaming`. An interface on another
  origin than the card is refused, and redirects are not followed, so `headers` only go to the host in
  `bridge.yaml`. The card's name, description and skills are never shown to agents. `bridge doctor` reads the card
  and shows the version and endpoint it found.
- **Credentials** are `headers` sent with every request, the card's included: `Authorization: "Bearer
  ${secret:name}"`, `X-API-Key: secret:name`, or `env:` references.
- **Conversations.** A conversation is one A2A context: each turn sends one message (the text and every attachment
  inline) with the conversation's `contextId`, and waits for its task. A streaming agent's status messages show as
  progress; otherwise the bridge asks for the task at once and polls it (`GetTask` after 0.5s, doubling to every
  10s).
- **Replies.** A completed task answers with its artifacts (text, data as JSON, files named with their URL), or its
  status message when it has none; an agent may also answer with a message and no task. A task that needs input
  (`input-required`, `auth-required`) answers with its question, and the conversation's next message goes to the
  same task. A failed, rejected or canceled task fails the turn with its status message.
- **Stopping.** A turn that is stopped, or has no answer within `timeout` (default `30m`), cancels its task
  (`CancelTask`). One cut off by a bridge shutdown leaves its task running: after the restart the turn rejoins it
  (`GetTask`, then `SubscribeToTask` or polling) instead of sending the request again. A task the agent no longer
  knows is asked for again. A delegated turn is not resumed, so a shutdown cancels its task.
- The bridge keeps `{"contextId","taskId"?,"open"?}` as the agent's session id; a session id from another agent type
  starts a new context. A2A reports no cost, so budgets don't limit A2A agents.
