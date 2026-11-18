import type { AgentConfig } from '../../config/schema.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import type { AgentTurn } from './types.ts';
import { CliAgent, shortStep, withFiles, type CliInvocation, type CliOutput } from './cli-agent.ts';

type CodexConfig = Extract<AgentConfig, { type: 'codex' }>;

/** The environment variable that hands Codex the turn's MCP token (never on its command line). */
const TOKEN_ENV = 'BRIDGE_MCP_TOKEN';

/**
 * Runs OpenAI's Codex CLI headless (`codex exec --json`) per turn, resuming the same Codex session across turns
 * of a thread. Codex reports tokens, not dollars, so its turns carry no cost and budgets don't limit them.
 */
export class CodexAgent extends CliAgent {
  protected readonly label = 'codex';
  private readonly cfg: CodexConfig;

  constructor(name: string, cfg: CodexConfig, secrets: SecretResolver) {
    super(name, cfg, secrets);
    this.cfg = cfg;
  }

  protected invocation(_cwd: string, turn: AgentTurn, instructions: string, resume: string | undefined): CliInvocation {
    // `-c key=value` values are TOML; a JSON string is a valid TOML basic string.
    const set = (key: string, value: string) => ['-c', `${key}=${JSON.stringify(value)}`];
    const args = [
      'exec',
      ...(resume ? ['resume', resume] : []),
      '--json',
      '--skip-git-repo-check',
      // Nobody is at a terminal to approve a command: what the sandbox refuses fails.
      ...set('approval_policy', 'never'),
      ...set('sandbox_mode', this.cfg.sandbox),
      ...set('developer_instructions', instructions),
      ...set('mcp_servers.bridge.url', turn.mcp.endpoint),
      ...set('mcp_servers.bridge.bearer_token_env_var', TOKEN_ENV),
      // The bridge's own tools are checked by its policies; Codex needn't ask again.
      ...set('mcp_servers.bridge.default_tools_approval_mode', 'approve'),
    ];
    if (this.cfg.model) args.push('--model', this.cfg.model);
    for (const f of turn.files ?? []) if (f.mime?.startsWith('image/')) args.push('--image', f.path);
    args.push('-'); // the prompt comes on stdin
    return {
      args,
      stdin: withFiles(turn, 'open them from these paths'),
      env: { ...process.env, [TOKEN_ENV]: turn.mcp.token },
    };
  }

  protected output(turn: AgentTurn): CliOutput {
    let text: string | undefined;
    let done: { failed?: string } | undefined;
    let lastError: string | undefined;
    return {
      event(ev, sessionId) {
        if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') sessionId(ev.thread_id);
        else if (ev.type === 'item.started' && ev.item) {
          const step = describeItem(ev.item);
          if (step) turn.onProgress?.(step);
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
          text = ev.item.text; // the last message of the turn is its answer
        } else if (ev.type === 'turn.completed') done = {};
        else if (ev.type === 'turn.failed') done = { failed: String(ev.error?.message ?? 'Codex failed') };
        else if (ev.type === 'error' && typeof ev.message === 'string') lastError = ev.message;
      },
      result: () => done && { text: done.failed !== undefined ? `⚠️ ${done.failed}` : (text ?? '') },
      failure: () => lastError,
    };
  }
}

/** A progress line for work Codex starts: a command, an MCP tool call, a file edit, a web search. */
function describeItem(item: any): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return shortStep('Run', unwrapShell(String(item.command ?? '')));
    case 'mcp_tool_call':
      return item.server === 'bridge' ? shortStep(String(item.tool), undefined) : shortStep(`${item.server}.${item.tool}`, undefined);
    case 'file_change':
      return shortStep('Edit', (item.changes ?? []).map((c: any) => c.path).join(', ') || undefined);
    case 'web_search':
      return shortStep('Search', item.query);
    default:
      return undefined;
  }
}

/** Codex runs commands as `/bin/zsh -lc '<command>'` (or unquoted when it needs no quoting); show the command. */
export function unwrapShell(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -lc (?:'(.*)'|([^'\s]+))$/s.exec(command);
  if (!m) return command;
  return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!;
}
