import type { BridgeConfig, Policy } from '../config/schema.ts';
import { anyGlob, parseDuration } from './address.ts';

export interface ApprovalRule {
  approvers: string[];
  timeoutMs: number;
}

/** How long an approval waits when no matching policy sets `timeout`. */
const APPROVAL_TIMEOUT = '10m';

/**
 * Evaluates `policies:`. A policy applies when every key in its `match` holds (a missing key matches anything);
 * every applying policy counts and the strictest value wins. `max_hops` / `budget_usd` are per agent, so
 * semanticCheck only allows them on policies that match by `agent` alone.
 */
export class PolicyEngine {
  private readonly cfg: BridgeConfig;
  constructor(cfg: BridgeConfig) {
    this.cfg = cfg;
  }

  maxHops(agent: string): number {
    const limits = this.forAgent(agent)
      .map((p) => p.max_hops)
      .filter((n): n is number => n !== undefined);
    return Math.min(this.cfg.defaults.max_hops, ...limits);
  }

  budgetUsd(agent: string): number | undefined {
    const b = this.forAgent(agent)
      .map((p) => p.budget_usd)
      .filter((n): n is number => n !== undefined);
    return b.length ? Math.min(...b) : undefined;
  }

  /**
   * Approval needed before `agent` runs `tool` (as "server.tool")? Approvers are merged across matching
   * policies, the shortest timeout wins. In a `tainted` turn every write needs one even without a policy:
   * `initiator` is added, which the bridge resolves to the owners for such a turn.
   */
  approvalFor(agent: string, tool: string, opts: { readOnly?: boolean; tainted?: boolean } = {}): ApprovalRule | undefined {
    const hits = this.cfg.policies.filter(
      (p) =>
        p.approve_by?.length &&
        (p.match.agent === undefined || anyGlob(p.match.agent, agent)) &&
        (p.match.tool === undefined || anyGlob(p.match.tool, tool)) &&
        !(p.match.writes && opts.readOnly),
    );
    const guarded = opts.tainted === true && !opts.readOnly;
    if (!hits.length && !guarded) return undefined;
    const approvers = [...new Set([...hits.flatMap((p) => p.approve_by ?? []), ...(guarded ? ['initiator'] : [])])];
    const timeouts = hits.map((p) => parseDuration(p.timeout ?? APPROVAL_TIMEOUT));
    return { approvers, timeoutMs: timeouts.length ? Math.min(...timeouts) : parseDuration(APPROVAL_TIMEOUT) };
  }

  /** Approval needed before a turn delegates? Only a `tainted` one, and the owners decide (via `initiator`). */
  delegationApproval(tainted: boolean): ApprovalRule | undefined {
    return tainted ? { approvers: ['initiator'], timeoutMs: parseDuration(APPROVAL_TIMEOUT) } : undefined;
  }

  private forAgent(agent: string): Policy[] {
    return this.cfg.policies.filter(
      (p) => p.match.tool === undefined && p.match.writes === undefined && (p.match.agent === undefined || anyGlob(p.match.agent, agent)),
    );
  }
}
