/**
 * @bridge-groups/bridge/local — agents that run code on the machine the bridge runs on: Claude Code (with a git
 * worktree per conversation) and stdio processes. Pass `localAgents` as the bridge's `agentFactory` to enable
 * them; a service that hosts other people's bridges should not, or should run each bridge in a sandbox.
 */
export { localAgents } from './adapters/agent/local.ts';
export { ClaudeCodeAgent } from './adapters/agent/claude-code.ts';
export { StdioAgent } from './adapters/agent/stdio.ts';
export { LocalConsoleAdapter } from './adapters/im/local.ts';
