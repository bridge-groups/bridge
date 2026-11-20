import type { Envelope } from '../../core/envelope.ts';

export interface AgentTurn {
  envelope: Envelope;
  /** Prompt text for this turn. */
  text: string;
  /** The agent's own session id from the previous turn in this bridge session, if any. */
  agentSessionId?: string;
  /** Files that came with this message, downloaded to local paths. */
  files?: { name: string; path: string; mime?: string }[];
  /** USD left in this conversation's budget; agents should stop before spending more. */
  budgetUsd?: number;
  /**
   * Session-scoped MCP endpoint the agent can call back into (send_message, ask_human, delegate, tools): `url`
   * carries the token in its path; `endpoint` is the same server for clients that send the token as
   * `Authorization: Bearer <token>` instead, which keeps it out of a command line. `callTimeoutMs` is how long one
   * call may wait for its result (an answer from a person, an approval, a delegated turn): agents whose MCP client
   * gives up sooner by default are told to allow this much.
   */
  mcp: { url: string; endpoint: string; token: string; callTimeoutMs: number };
  /** Short progress lines ("Reading src/…"). */
  onProgress?: (line: string) => void;
  /** The agent's session id, as soon as it is known (lets a crashed turn be resumed). */
  onSessionId?: (id: string) => void;
  /** A one-off note for the conversation (e.g. "working on branch X"). */
  onNotice?: (text: string) => void;
  /**
   * The bridge restarted during this turn and runs it again; `text` asks the agent to finish the original
   * request. An agent whose work goes on elsewhere may rejoin that work instead.
   */
  resume?: boolean;
  /** Ends the turn; its reason is a ShuttingDown when the bridge is stopping and the turn resumes on the next start. */
  signal?: AbortSignal;
}

/** Why a turn ended when the bridge shuts down: it resumes on the next start, so work running elsewhere can go on. */
export class ShuttingDown extends Error {
  constructor() {
    super('the bridge is shutting down');
    this.name = 'ShuttingDown';
  }
}

export interface AgentReply {
  text: string;
  agentSessionId?: string;
  costUsd?: number;
}

/**
 * Where an agent's work lives between turns (a git branch), for the in-thread status/merge/discard commands.
 * Every method runs git (possibly over the network for PRs), so all of them are async.
 */
export interface Workspace {
  /**
   * The branch's status for people (name, unmerged commits, diffstat, uncommitted files), or undefined when
   * this conversation has no branch yet.
   */
  status(sessionKey: string): Promise<string | undefined>;
  /** What merging would do, or why it can't happen now. */
  previewMerge(sessionKey: string): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>;
  merge(sessionKey: string): Promise<string>;
  /**
   * What discarding would throw away: '' when there is nothing to lose, undefined when there is no
   * branch. Anything else (including "can't tell") must be confirmed before discarding.
   */
  previewDiscard(sessionKey: string): Promise<string | undefined>;
  discard(sessionKey: string): Promise<string>;
  /**
   * Remove worktrees whose conversation is idle and that are known to hold nothing unmerged.
   * `isIdle(slug)` decides (slug = sessionSlug(key)). A worktree that fails is listed in `errors`
   * and doesn't stop the others.
   */
  prune(isIdle: (slug: string) => boolean): Promise<{ removed: string[]; errors: string[] }>;
  /** Push the branch and open a pull request; absent when no git token is configured. */
  previewPr?(sessionKey: string): Promise<{ ok: true; summary: string } | { ok: false; reason: string }>;
  pr?(sessionKey: string): Promise<string>;
}

export interface AgentAdapter {
  readonly name: string;
  run(turn: AgentTurn): Promise<AgentReply>;
  stop?(): Promise<void>;
  /** Present when the agent keeps its work on a per-conversation branch. */
  readonly workspace?: Workspace;
}
