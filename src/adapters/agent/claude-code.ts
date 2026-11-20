import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig } from '../../config/schema.ts';
import type { SecretResolver } from '../../core/secrets.ts';
import { DEFAULT_TEMP_DIR, privateDir } from '../../core/temp.ts';
import type { AgentReply, AgentTurn } from './types.ts';
import { CliAgent, shortStep, withFiles, type CliInvocation, type CliOutput } from './cli-agent.ts';

type ClaudeCodeConfig = Extract<AgentConfig, { type: 'claude-code' }>;

/** Runs Claude Code headless (`claude -p`) per turn, resuming the same Claude session across turns of a thread. */
export class ClaudeCodeAgent extends CliAgent {
  protected readonly label = 'claude';
  private readonly cfg: ClaudeCodeConfig;
  /** Each turn's MCP settings file goes in a folder of its own here. */
  private readonly tempDir: string;

  constructor(name: string, cfg: ClaudeCodeConfig, secrets: SecretResolver, tempDir = DEFAULT_TEMP_DIR) {
    super(name, cfg, secrets);
    this.cfg = cfg;
    this.tempDir = tempDir;
  }

  protected invocation(_cwd: string, turn: AgentTurn, instructions: string, resume: string | undefined): CliInvocation {
    const dir = mkdtempSync(join(privateDir(this.tempDir), 'claude-'));
    const mcpFile = join(dir, 'mcp.json');
    // `timeout` (ms) is Claude Code's limit for one call to this server; without it an HTTP call ends after 60s.
    const bridge = { type: 'http', url: turn.mcp.url, timeout: turn.mcp.callTimeoutMs };
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { bridge } }), {
      mode: 0o600,
    });
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpFile,
      '--append-system-prompt', instructions,
      '--permission-mode', this.cfg.permission_mode,
      '--allowedTools', ['mcp__bridge', ...this.cfg.allowed_tools].join(','),
    ];
    if (resume) args.push('--resume', resume);
    // Attachments live outside the repo; let Claude read their folder.
    for (const dir of new Set((turn.files ?? []).map((f) => dirname(f.path)))) args.push('--add-dir', dir);
    // Hard cap for this turn: whatever is left of the conversation budget.
    if (turn.budgetUsd !== undefined) args.push('--max-budget-usd', turn.budgetUsd.toFixed(2));
    if (this.cfg.model) args.push('--model', this.cfg.model);
    return {
      args,
      stdin: withFiles(turn, 'read them with the Read tool'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  protected output(turn: AgentTurn): CliOutput {
    let result: AgentReply | undefined;
    return {
      event(ev, sessionId) {
        if (typeof ev.session_id === 'string') sessionId(ev.session_id);
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use') turn.onProgress?.(describeToolUse(block.name, block.input));
          }
        } else if (ev.type === 'result') {
          // The subtype Claude Code reports when it stops at --max-budget-usd.
          const overBudget = ev.subtype === 'error_max_budget_usd';
          result = {
            text: overBudget
              ? `💸 Stopped: this turn reached the conversation's remaining budget ($${turn.budgetUsd?.toFixed(2)}). Send "reset" to start a new conversation with a fresh budget.`
              : ev.is_error
                ? `⚠️ ${failure(ev)}`
                : String(ev.result ?? ''),
            agentSessionId: typeof ev.session_id === 'string' ? ev.session_id : undefined,
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          };
        }
      },
      result: () => result,
    };
  }
}

/**
 * Why a failed run failed. A run that fails before the model answers (e.g. "No conversation found with session ID")
 * has no `result`, only the subtype and its reasons in `errors`; keep both so the reply says what went wrong.
 */
function failure(ev: any): string {
  const errors = Array.isArray(ev.errors) ? ev.errors.filter((e: unknown) => typeof e === 'string' && e) : [];
  const reason = ev.result ?? ev.subtype ?? 'Claude Code failed';
  return errors.length ? `${reason}: ${errors.join('; ')}` : String(reason);
}

function describeToolUse(name: string, input: any): string {
  return shortStep(name.replace(/^mcp__bridge__/, ''), input?.file_path ?? input?.path ?? input?.pattern ?? input?.command ?? input?.url);
}
