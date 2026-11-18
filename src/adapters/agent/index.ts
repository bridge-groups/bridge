import type { AgentConfig } from '../../config/schema.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentAdapter } from './types.ts';
import { WebhookAgent } from './webhook.ts';

/** Builds the adapter for one agent of the config; the bridge calls it when the agent is first needed. */
export type AgentFactory = (
  name: string,
  cfg: AgentConfig,
  ctx: { secrets: SecretResolver; /** The bridge's private temp folder, for agents' scratch files. */ tempDir: string },
) => AgentAdapter;

/**
 * Agents that run elsewhere and are reached over the network. Agents that run code on this machine
 * (claude-code, codex, stdio) come from `localAgents` in the `/local` entry point, which an embedding app opts into.
 */
export const remoteAgents: AgentFactory = (name, cfg, { secrets }) => {
  if (cfg.type === 'webhook') return new WebhookAgent(name, cfg, secrets);
  throw new Error(`agent "${name}" (type ${cfg.type}) runs on this machine — enable local agents to use it`);
};
