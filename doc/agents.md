# Writing an agent

An agent is anything that takes a turn (a message and its context) and returns a reply. Claude Code and Codex are
built in; any other agent is a **webhook** (an HTTP service) or a **stdio** process (a long-running local program).

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
