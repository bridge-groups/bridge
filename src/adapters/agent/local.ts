import { ClaudeCodeAgent } from './claude-code.ts';
import { remoteAgents, type AgentFactory } from './index.ts';
import { StdioAgent } from './stdio.ts';

/** Every agent type, including those that run code on this machine: claude-code (with git worktrees) and stdio. */
export const localAgents: AgentFactory = (name, cfg, ctx) => {
  if (cfg.type === 'claude-code') return new ClaudeCodeAgent(name, cfg, ctx.secrets);
  if (cfg.type === 'stdio') return new StdioAgent(name, cfg, ctx.secrets);
  return remoteAgents(name, cfg, ctx);
};
