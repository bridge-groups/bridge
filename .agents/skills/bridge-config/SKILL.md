---
name: bridge-config
description: Change a bridge.yaml (people, IM connections, agents, tool servers, routes, policies, tests) for the user. Use when the user asks to connect a channel or person to an agent, add an agent or MCP tool server, grant or restrict tools, add approvals or budgets, or otherwise change how bridge routes messages.
---

# Change bridge.yaml

Outcome: `bridge.yaml` does what the user asked and nothing more, `bridge check` passes, the file's `tests` pin
the behaviour the user relies on, and the user knows which changes wait for their confirmation.

1. Read the user's `bridge.yaml` and [doc/config.md](../../../doc/config.md). The schema with every key and default
   is `doc/bridge.schema.json`; `bridge schema` prints it.
2. Make the smallest edit that does what was asked. Keep comments and ordering. Routes match top to bottom, so
   put a new route where it wins only for the messages it is meant for.
3. Never write a credential into the file. If one is needed, tell the user to run
   `bridge secret set <name>` themselves (the value goes in on stdin) and reference it as `secret:<name>`.
4. A route from IM to an agent on this machine needs `when.sender`. Name people, not `anyone`, unless the user
   asked for anyone.
5. Add or update `tests` for what the user relies on, including who must not get through
   (`expect: none`, `expect: deny`).
6. Run `bridge check` (from a checkout: `node src/cli.ts check -c <path>`; add `--json` for structured output)
   and fix every problem it lists.
7. Report the change list `bridge check` prints. Changes marked `+` widen access and wait for an owner: tell the
   user to confirm them with the buttons in their DM with the bot, on the dashboard, or with
   `bridge check --apply`. Never run `bridge check --apply` yourself: confirming is the user's decision.

If you cannot run commands, still make the edit and the tests, then ask the user to run `bridge check`.
