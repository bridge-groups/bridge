import { isDeepStrictEqual } from 'node:util';
import type { BridgeConfig, Policy, Route } from './schema.ts';

/** One difference between the running config and a new one. */
export interface ConfigChange {
  section: string;
  /** The entry: a person, agent, tool or IM name, or a route / policy as text. */
  key: string;
  kind: 'added' | 'removed' | 'changed' | 'reordered';
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
  for (const section of ['people', 'agents', 'tools', 'im'] as const) {
    const a = prev[section] as Record<string, unknown>;
    const b = next[section] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(b, key)) out.push({ section, key, kind: 'removed', widens: false });
      else if (!Object.hasOwn(a, key)) out.push({ section, key, kind: 'added', widens: true });
      else if (!isDeepStrictEqual(a[key], b[key])) out.push({ section, key, kind: 'changed', widens: true });
    }
  }

  // Routes match first-to-last, so a new route or a new order can let a message reach another agent.
  const routes = listChanges(prev.routes, next.routes, routeText);
  out.push(...routes.added.map((key) => ({ section: 'routes', key, kind: 'added' as const, widens: true })));
  out.push(...routes.removed.map((key) => ({ section: 'routes', key, kind: 'removed' as const, widens: false })));
  if (routes.reordered) out.push({ section: 'routes', key: 'order', kind: 'reordered', widens: true });

  // A removed policy lifts an approval or limit; an added one only adds them, unless it names new approvers.
  const policies = listChanges(prev.policies, next.policies, policyText);
  const added = next.policies.filter((p) => !prev.policies.some((q) => isDeepStrictEqual(p, q)));
  for (const p of added) {
    const approvers = (p.approve_by ?? []).some((who) => who !== 'initiator');
    out.push({ section: 'policies', key: policyText(p), kind: 'added', widens: approvers });
  }
  out.push(...policies.removed.map((key) => ({ section: 'policies', key, kind: 'removed' as const, widens: true })));

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

/** Entries only in `b` (added) or only in `a` (removed), counting duplicates; `reordered` when only the order differs. */
function listChanges<T>(a: T[], b: T[], text: (t: T) => string) {
  const left = [...a];
  const added: string[] = [];
  for (const item of b) {
    const i = left.findIndex((x) => isDeepStrictEqual(x, item));
    if (i >= 0) left.splice(i, 1);
    else added.push(text(item));
  }
  const removed = left.map(text);
  const reordered = !added.length && !removed.length && !isDeepStrictEqual(a, b);
  return { added, removed, reordered };
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
  return changes.map((c) => `${c.widens ? '+' : c.kind === 'removed' ? '-' : '~'} ${c.section} ${c.kind}: ${c.key}`);
}
