import { z } from 'zod';
import { MAX_TIMER_MS, parseDuration } from '../core/address.ts';

export const TRUST_LEVELS = ['owner', 'trusted', 'member', 'agent', 'external'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** A credential reference: `secret:<name>` (OS keychain), `env:<NAME>`, or a literal (discouraged). */
const SecretRef = z.string().min(1);

const parses = (s: string) => {
  try {
    parseDuration(s);
    return true;
  } catch {
    return false;
  }
};
/** A length of time such as 30s, 10m, 2h, 7d. */
const Duration = z.string().refine(parses, { message: 'expected a duration such as 30s, 10m, 2h or 7d' });
/** A duration that drives a timer, so it must fit setTimeout (under ~24.8 days). */
const TimerDuration = Duration.refine((s) => !parses(s) || parseDuration(s) <= MAX_TIMER_MS, {
  message: 'too long for a timer (at most 24d)',
});

const Person = z
  .object({
    trust: z.enum(TRUST_LEVELS).default('member'),
    slack: z.string().optional(),
    telegram: z.string().optional(),
    feishu: z.string().optional(),
    discord: z.string().optional(),
  })
  .strict();
export type Person = z.infer<typeof Person>;

/** A person's user id on an IM (`local`, the console, has none: people are named directly there). */
export function personIdOn(person: Person, platform: string): string | undefined {
  return platform === 'slack' || platform === 'telegram' || platform === 'feishu' || platform === 'discord' ? person[platform] : undefined;
}

const SlackConfig = z
  .object({ app_token: SecretRef, bot_token: SecretRef })
  .strict();
const TelegramConfig = z.object({ bot_token: SecretRef }).strict();
const FeishuConfig = z
  .object({
    app_id: z.string().min(1),
    app_secret: SecretRef,
    /** feishu = open.feishu.cn (China), lark = open.larksuite.com (international). */
    domain: z.enum(['feishu', 'lark']).default('feishu'),
  })
  .strict();

const DiscordConfig = z
  .object({
    bot_token: SecretRef,
    /**
     * Ask for the privileged Message Content intent (switch it on under Bot in the Developer Portal). Without it
     * the bot only reads DMs, messages that @-mention it and replies to it, so `mention: false` routes need it.
     */
    message_content: z.boolean().default(false),
  })
  .strict();

const ImConfig = z
  .object({
    slack: SlackConfig.optional(),
    telegram: TelegramConfig.optional(),
    feishu: FeishuConfig.optional(),
    discord: DiscordConfig.optional(),
  })
  .strict()
  .default({});

/** Settings of the coding agents that run as a CLI per turn (claude-code, codex). */
const codingAgentFields = {
  cwd: z.string().optional(),
  model: z.string().optional(),
  /** Give every conversation its own git worktree + branch so parallel threads never touch the same checkout. */
  worktree: z.boolean().default(false),
  worktree_dir: z.string().default('~/.bridge/worktrees'),
  /** Untracked paths linked into each worktree from the main checkout (e.g. node_modules, .env). */
  worktree_links: z.array(z.string()).default([]),
  /** Token used to push conversation branches and open PRs (the `pr` command). */
  git_token: SecretRef.optional(),
  description: z.string().optional(),
};

const ClaudeCodeAgent = z
  .object({
    type: z.literal('claude-code'),
    /** Path to the `claude` executable. */
    command: z.string().default('claude'),
    permission_mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).default('default'),
    allowed_tools: z.array(z.string()).default([]),
    ...codingAgentFields,
  })
  .strict();

const CodexAgent = z
  .object({
    type: z.literal('codex'),
    /** Path to the `codex` executable. */
    command: z.string().default('codex'),
    /**
     * What Codex's commands may do: read-only; workspace-write (write in the working directory, no network);
     * danger-full-access (anything you can). Commands are never put to you for approval: what the sandbox
     * refuses fails.
     */
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
    ...codingAgentFields,
  })
  .strict();

const WebhookAgent = z
  .object({
    type: z.literal('webhook'),
    url: z.string().url(),
    headers: z.record(z.string(), SecretRef).default({}),
    timeout: TimerDuration.default('10m'),
    description: z.string().optional(),
  })
  .strict();

/** A remote agent speaking A2A (Agent2Agent) 1.0 or 0.3 over JSON-RPC. */
const A2aAgent = z
  .object({
    type: z.literal('a2a'),
    /** The agent card's URL, or the base URL it lives under (/.well-known/agent-card.json is added). */
    url: z.url({ protocol: /^https?$/ }),
    /** Sent with every request, card included. Values may be "secret:x", "env:X" or contain ${secret:x} / ${env:X}. */
    headers: z.record(z.string(), z.string()).default({}),
    /** A turn whose task hasn't completed or asked for input after this long fails, and its task is canceled. */
    timeout: TimerDuration.default('30m'),
    description: z.string().optional(),
  })
  .strict();

const StdioAgent = z
  .object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), SecretRef).default({}),
    /** A turn without a reply after this long fails (the agent is sent a cancel for it). */
    timeout: TimerDuration.default('30m'),
    description: z.string().optional(),
  })
  .strict();

export const AgentConfig = z.discriminatedUnion('type', [ClaudeCodeAgent, CodexAgent, WebhookAgent, A2aAgent, StdioAgent]);
export type AgentConfig = z.infer<typeof AgentConfig>;

/** An external tool server the bridge proxies: a local MCP process (stdio)… */
const StdioToolServer = z
  .object({
    type: z.literal('mcp').default('mcp'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), SecretRef).default({}),
    /** How long one tool call may run (progress notifications extend it). */
    timeout: TimerDuration.default('5m'),
    description: z.string().optional(),
  })
  .strict();

/** …or a remote one over HTTP. Header values may be "secret:x", "env:X" or contain ${secret:x} / ${env:X}. */
const HttpToolServer = z
  .object({
    type: z.literal('mcp').default('mcp'),
    url: z.url(),
    /** streamable-http (current spec) or sse (older servers); auto tries streamable-http, then sse. */
    transport: z.enum(['auto', 'streamable-http', 'sse']).default('auto'),
    headers: z.record(z.string(), z.string()).default({}),
    /**
     * Sign in with OAuth (run `bridge auth <server>` once). `true` uses dynamic client
     * registration; servers without it need a pre-registered `client_id` (+ `client_secret`).
     */
    oauth: z
      .union([
        z.literal(true),
        z
          .object({
            scopes: z.array(z.string()).optional(),
            client_id: z.string().optional(),
            client_secret: SecretRef.optional(),
          })
          .strict(),
      ])
      .optional(),
    /** How long one tool call may run (progress notifications extend it). */
    timeout: TimerDuration.default('5m'),
    description: z.string().optional(),
  })
  .strict();

const ToolServer = z.union([StdioToolServer, HttpToolServer]);
export type ToolServerConfig = z.infer<typeof ToolServer>;
export type HttpToolServerConfig = z.infer<typeof HttpToolServer>;

const OneOrMany = z.union([z.string(), z.array(z.string()).min(1)]);

const RouteWhen = z.strictObject(
  {
    /**
     * `true` (or unset): in a channel the bot must be @-mentioned; DMs always count as mentioned. `<agent>`: the
     * bot is mentioned and the message starts with this agent's name. `false`: every message in the channel,
     * no mention needed. Replies in a thread the agent holds never need one.
     */
    mention: z.union([z.boolean(), z.string()]).optional(),
    /** Person ids from `people`, or `anyone`. */
    sender: z.union([z.literal('anyone'), z.array(z.string()).min(1)]).optional(),
  },
  {
    error: (iss) =>
      iss.code === 'unrecognized_keys' && iss.keys.includes('listen')
        ? 'when.listen is not a setting: write mention: false for every message in the channel'
        : undefined,
  },
);

export const Route = z
  .object({
    from: z.string().min(1),
    when: RouteWhen.default({}),
    to: OneOrMany,
  })
  .strict();
export type Route = z.infer<typeof Route>;

export const Policy = z
  .object({
    match: z
      .object({
        tool: OneOrMany.optional(),
        /** Only tools that may change something (the MCP server doesn't mark them readOnlyHint). */
        writes: z.boolean().optional(),
        agent: OneOrMany.optional(),
      })
      .strict(),
    approve_by: z.array(z.string()).optional(),
    /** How long an approval waits (default 10m). */
    timeout: TimerDuration.optional(),
    max_hops: z.number().int().positive().optional(),
    budget_usd: z.number().positive().optional(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

const Defaults = z
  .object({
    dm_idle_reset: Duration.default('2h'),
    offline_queue_ttl: Duration.default('24h'),
    progress: z.enum(['collapsed', 'verbose', 'off']).default('collapsed'),
    max_hops: z.number().int().positive().default(4),
    /** Attachments larger than this are not downloaded. */
    max_file_mb: z.number().positive().default(20),
    /** Downloaded attachments are deleted after this long. */
    files_ttl: Duration.default('7d'),
    /** Idle conversation worktrees with nothing unmerged are removed after this long ("off" to keep). */
    worktree_prune_after: z.union([z.literal('off'), Duration]).default('7d'),
    /** Trace entries and conversations idle for longer than this are deleted ("off" to keep them forever). */
    retention: z.union([z.literal('off'), Duration]).default('30d'),
  })
  .strict()
  .prefault({});

/**
 * Assertions about the routing this file sets up, checked whenever it is loaded: a file whose tests fail is not
 * applied. An inbound test sends a message from an IM address; an outbound test asks whether an agent may call a
 * tool ("server.tool") or delegate to another agent.
 */
const InboundTest = z
  .object({
    /** IM address the message comes from: "slack:#dev", "feishu:dm", "slack:C0123". */
    from: z.string().regex(/^[a-z]+:.+$/, 'expected an IM address such as slack:#dev or slack:dm'),
    /** A person id from people, or a platform user id; leave out for someone unknown. */
    sender: z.string().optional(),
    mention: z.boolean().default(false),
    text: z.string().default('hello'),
    /** The agent that should get the message, or "none". */
    expect: z.string(),
  })
  .strict();
const OutboundTest = z
  .object({
    agent: z.string(),
    /** "server.tool" or another agent's name. */
    calls: z.string(),
    expect: z.enum(['allow', 'deny']),
  })
  .strict();
export const RouteTest = z.union([InboundTest, OutboundTest]);
export type RouteTest = z.infer<typeof RouteTest>;

const Server = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7377),
    /** The conversation database (`~/…` from home, else from the config file's folder). */
    data_dir: z.string().default('~/.bridge'),
  })
  .strict()
  .prefault({});

export const BridgeConfig = z
  .object({
    version: z.literal(1).default(1),
    server: Server,
    people: z.record(z.string(), Person).default({}),
    im: ImConfig,
    agents: z.record(z.string(), AgentConfig).default({}),
    tools: z.record(z.string(), ToolServer).default({}),
    routes: z.array(Route).default([]),
    policies: z.array(Policy).default([]),
    defaults: Defaults,
    tests: z.array(RouteTest).default([]),
  })
  .strict();
export type BridgeConfig = z.infer<typeof BridgeConfig>;
