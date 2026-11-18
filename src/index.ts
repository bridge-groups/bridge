/**
 * @bridge-groups/bridge — the library. Embed a bridge in an app or service: the app hands it the config, a way
 * to resolve secrets, a store and IM connections, and mounts `bridge.handle` on its own HTTP server. Nothing
 * here reads config files, the OS keychain or the dashboard; that is the CLI's (`bridge`).
 *
 * Agents that run code on this machine (claude-code, codex, stdio) are opt-in: `@bridge-groups/bridge/local`.
 */

// The bridge
export { Bridge, type AuditEntry, type BridgeOptions, type PendingChoice, type SessionInfo, type ToolServerInfo } from './core/bridge.ts';

// Config: parse and check it, see what a change does
export { parseConfig, checkConfig, formatIssue, ConfigError, type ConfigIssue } from './config/load.ts';
export { configChanges, describeChanges, type ConfigChange } from './config/changes.ts';
export { configJsonSchema } from './config/json-schema.ts';
export type { AgentConfig, BridgeConfig, Person, Policy, Route, RouteTest, ToolServerConfig, TrustLevel } from './config/schema.ts';

// State
export { SqliteStore, type BridgeStore, type QueueRow, type SessionRow, type TraceRow } from './core/store.ts';

// Secrets
export { envSecrets, resolveTemplate, secretEnvName, type SecretResolver } from './core/secrets.ts';
export { Redactor, looksLikeSecret } from './core/redact.ts';

// Routing
export { Router, type InboundFile, type InboundMessage } from './core/router.ts';
export type { ContentBlock, Envelope, Sender } from './core/envelope.ts';

// IM connections
export type { Choice, ImAdapter, InboundAction, OutboundMessage } from './adapters/im/types.ts';
export { SlackAdapter } from './adapters/im/slack.ts';
export { FeishuAdapter } from './adapters/im/feishu.ts';
export { TelegramAdapter } from './adapters/im/telegram.ts';
export { DiscordAdapter } from './adapters/im/discord.ts';

// Agents reached over the network
export type { AgentAdapter, AgentReply, AgentTurn, Workspace } from './adapters/agent/types.ts';
export { remoteAgents, type AgentFactory } from './adapters/agent/index.ts';
export { WebhookAgent } from './adapters/agent/webhook.ts';

// Tool servers and their OAuth sign-in
export { ToolHub, type ToolHubOptions } from './mcp/tools.ts';
export { memoryStorage, NeedsSignIn, type OAuthStatus, type OAuthStorage, type SignInResult, type StoredAuth } from './mcp/oauth.ts';
