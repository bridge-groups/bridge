import type { AgentReply, AgentTurn } from './types.ts';

/**
 * The messages stdio and webhook agents exchange with the bridge (see README "Agent protocols"). A stdio agent
 * adds the turn's `id` to every line; a webhook agent answers one turn per request.
 *
 *   bridge → agent  {"type":"turn","text","session_id","budget_usd","files","envelope","mcp":{"url"}}
 *   agent → bridge  {"type":"progress","text"}
 *                   {"type":"session","session_id"}       the agent's own session id, as soon as it is known
 *                   {"type":"reply","text","session_id"?,"cost_usd"?}
 *                   {"type":"error","message"}
 */
export function turnMessage(turn: AgentTurn) {
  return {
    type: 'turn' as const,
    text: turn.text,
    session_id: turn.agentSessionId ?? null,
    budget_usd: turn.budgetUsd ?? null,
    files: turn.files ?? [],
    envelope: turn.envelope,
    mcp: { url: turn.mcp.url },
  };
}

export type AgentEvent =
  | { type: 'progress'; text: string }
  | { type: 'session'; id: string }
  | { type: 'reply'; reply: AgentReply }
  | { type: 'error'; message: string };

/**
 * What a message from `agent` means; undefined for types this bridge doesn't know (newer agents). A reply
 * without `session_id` keeps `sessionId`, the latest one the turn knows.
 */
export function agentEvent(msg: Record<string, unknown>, sessionId: string | undefined, agent: string): AgentEvent | undefined {
  switch (msg.type) {
    case 'progress':
      return typeof msg.text === 'string' ? { type: 'progress', text: msg.text } : undefined;
    case 'session':
      return typeof msg.session_id === 'string' ? { type: 'session', id: msg.session_id } : undefined;
    case 'reply':
      if (typeof msg.text !== 'string') return { type: 'error', message: `${agent}: reply has no "text" string` };
      return {
        type: 'reply',
        reply: {
          text: msg.text,
          agentSessionId: typeof msg.session_id === 'string' ? msg.session_id : sessionId,
          costUsd: typeof msg.cost_usd === 'number' ? msg.cost_usd : undefined,
        },
      };
    case 'error':
      return { type: 'error', message: `${agent}: ${typeof msg.message === 'string' ? msg.message : 'agent failed'}` };
    default:
      return undefined;
  }
}
