import { isDeepStrictEqual } from 'node:util';
import type { BridgeConfig, Policy, Route } from './schema.ts';

/** One difference between the running config and a new one. */
export interface ConfigChange {
  section: string;
  /** The entry: a person, agent, tool or IM name, or a route / policy as text. */
  key: string;
  kind: 'added' | 'removed' | 'changed' | 'reordered';
  /** For a changed agent or tool server: the settings that differ. */
  fields?: string[];
  /** Lets someone or something do what it could not before; such a change waits for an owner to confirm it. */
  widens: boolean;
}

/**
 * What changes between `prev` and `next`, and which changes widen access. When in doubt a change counts as
 * widening: an owner confirming a harmless change costs a click, an unconfirmed widening is a hole.
 */
export function configChanges(prev: BridgeConfig, next: BridgeConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  // Named entries: anything new or different can reach further (a person's id, an agent's command, a token).
  // Agents and tool servers are compared setting by setting, so a new description or model needs no one.
  for (const section of ['people', 'agents', 'tools', 'im'] as const) {
    const a = prev[section] as Record<string, unknown>;
    const b = next[section] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(b, key)) out.push({ section, key, kind: 'removed', widens: false });
      else if (!Object.hasOwn(a, key)) out.push({ section, key, kind: 'added', widens: true });
      else if (isDeepStrictEqual(a[key], b[key])) continue;
      else if (section === 'agents' || section === 'tools') {
        const fields = changedFields(a[key] as Settings, b[key] as Settings);
        const widens = fields.some((f) => fieldWidens(f, (a[key] as Settings)[f], (b[key] as Settings)[f]));
        out.push({ section, key, kind: 'changed', widens, fields });
      } else out.push({ section, key, kind: 'changed', widens: true });
    }
  }

  // Routes match first-to-last, so a new route or a new order can let a message reach another agent.
  const routes = listChanges(prev.routes, next.routes);
  out.push(...routes.added.map((r) => ({ section: 'routes', key: routeText(r), kind: 'added' as const, widens: true })));
  out.push(...routes.removed.map((r) => ({ section: 'routes', key: routeText(r), kind: 'removed' as const, widens: false })));
  if (routes.reordered) out.push({ section: 'routes', key: 'order', kind: 'reordered', widens: true });

  // A removed policy lifts an approval or limit; an added one only adds them, unless it names new approvers.
  // Their order doesn't matter: every applying policy counts.
  const policies = listChanges(prev.policies, next.policies);
  for (const p of policies.added) {
    const approvers = (p.approve_by ?? []).some((who) => who !== 'initiator');
    out.push({ section: 'policies', key: policyText(p), kind: 'added', widens: approvers });
  }
  out.push(...policies.removed.map((p) => ({ section: 'policies', key: policyText(p), kind: 'removed' as const, widens: true })));

  if (prev.server.host !== next.server.host) out.push({ section: 'server', key: 'host', kind: 'changed', widens: true });
  for (const key of ['port', 'data_dir'] as const) {
    if (prev.server[key] !== next.server[key]) out.push({ section: 'server', key, kind: 'changed', widens: false });
  }
  for (const key of Object.keys(next.defaults) as (keyof BridgeConfig['defaults'])[]) {
    if (prev.defaults[key] === next.defaults[key]) continue;
    // More hops lets a request travel further through delegation; the other defaults are housekeeping.
    const widens = key === 'max_hops' && next.defaults.max_hops > prev.defaults.max_hops;
    out.push({ section: 'defaults', key, kind: 'changed', widens });
  }
  if (!isDeepStrictEqual(prev.tests, next.tests)) out.push({ section: 'tests', key: 'tests', kind: 'changed', widens: false });
  return out;
}

type Settings = Record<string, unknown>;

function changedFields(a: Settings, b: Settings): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => !isDeepStrictEqual(a[f], b[f])).sort();
}

/** Settings that describe or pace an agent or tool server without changing what it can reach or do. */
const INERT = new Set(['description', 'timeout', 'model']);

/** Settings with a known order from least to most access; moving down that order narrows. */
const LADDERS: Record<string, readonly unknown[]> = {
  permission_mode: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
  sandbox: ['read-only', 'workspace-write', 'danger-full-access'],
};

/**
 * Whether changing one setting of an agent or tool server can widen access. Anything not known to be harmless
 * (a command, URL, header, directory, environment, type) counts as widening.
 */
function fieldWidens(field: string, a: unknown, b: unknown): boolean {
  if (INERT.has(field)) return false;
  const ladder = LADDERS[field];
  if (ladder && ladder.includes(a) && ladder.includes(b)) return ladder.indexOf(b) > ladder.indexOf(a);
  // Fewer pre-approved tools narrows; any new one widens.
  if (field === 'allowed_tools' && Array.isArray(a) && Array.isArray(b)) return b.some((t) => !a.includes(t));
  // Turning worktrees on keeps the agent off your checkout; turning them off puts it there.
  if (field === 'worktree') return b !== true;
  return true;
}

/** Entries only in `b` (added) or only in `a` (removed), counting duplicates; `reordered` when only the order differs. */
function listChanges<T>(a: T[], b: T[]) {
  const left = [...a];
  const added: T[] = [];
  for (const item of b) {
    const i = left.findIndex((x) => isDeepStrictEqual(x, item));
    if (i >= 0) left.splice(i, 1);
    else added.push(item);
  }
  const reordered = !added.length && !left.length && !isDeepStrictEqual(a, b);
  return { added, removed: left, reordered };
}

function routeText(r: Route): string {
  const when = Object.entries(r.when)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  return `${r.from} → ${Array.isArray(r.to) ? r.to.join(', ') : r.to}${when.length ? ` (${when.join('; ')})` : ''}`;
}

function policyText(p: Policy): string {
  const match = Object.entries(p.match)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('; ');
  const rest = Object.entries(p)
    .filter(([k, v]) => k !== 'match' && v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join('; ');
  return `match {${match}}${rest ? ` ${rest}` : ''}`;
}

/** One line per change: "+" widens, "-" narrows, "~" neither. */
export function describeChanges(changes: ConfigChange[]): string[] {
  return changes.map(
    (c) => `${c.widens ? '+' : c.kind === 'removed' ? '-' : '~'} ${c.section} ${c.kind}: ${c.key}${c.fields?.length ? ` (${c.fields.join(', ')})` : ''}`,
  );
}
