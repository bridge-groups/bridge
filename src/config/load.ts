import { readFileSync } from 'node:fs';
import { isMap, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import { BridgeConfig } from './schema.ts';
import { parseAddress } from '../core/address.ts';
import { looksLikeSecret } from '../core/redact.ts';
import { Router } from '../core/router.ts';

/** One problem with a config file: where it is (key path, and line when known) and what is wrong. */
export interface ConfigIssue {
  path: (string | number)[];
  message: string;
  /** 1-based line in the file. */
  line?: number;
}

export function formatIssue(i: ConfigIssue): string {
  const where = formatPath(i.path) || '(root)';
  return `${i.line !== undefined ? `line ${i.line}: ` : ''}${where}: ${i.message}`;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(`bridge.yaml is invalid:\n  - ${issues.map(formatIssue).join('\n  - ')}`);
    this.issues = issues;
  }
}

export function loadConfigFile(path: string): BridgeConfig {
  return parseConfig(readFileSync(path, 'utf8'));
}

/** Parse and check a config; throws ConfigError listing every problem. */
export function parseConfig(text: string): BridgeConfig {
  const { config, issues } = checkConfig(text);
  if (!config) throw new ConfigError(issues);
  return config;
}

/**
 * Everything wrong with a config file, each with its line: YAML syntax, the schema, references between sections,
 * literal credentials, and the file's own `tests`. `config` is set only when there is nothing wrong.
 */
export function checkConfig(text: string): { config?: BridgeConfig; issues: ConfigIssue[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) {
    return {
      issues: doc.errors.map((e) => ({ path: [], message: e.message.split('\n')[0]!, line: lines.linePos(e.pos[0]).line })),
    };
  }
  const at = (issue: ConfigIssue): ConfigIssue => ({ ...issue, line: lineOf(doc, lines, issue.path) });
  const raw = doc.toJS() ?? {};
  const secrets = literalSecrets(raw).map(at);
  const result = BridgeConfig.safeParse(raw);
  if (!result.success) {
    const schema = result.error.issues.map((i) => at({ path: i.path.filter(isKey), message: i.message }));
    return { issues: [...schema, ...secrets] };
  }
  const semantic = [...semanticCheck(result.data), ...secrets];
  // Tests only mean something once the routes they exercise are valid.
  const issues = semantic.length ? semantic : runTests(result.data);
  return issues.length ? { issues: issues.map(at) } : { config: result.data, issues: [] };
}

/** Checks zod cannot express: references resolve, and local agents never take IM input from unnamed senders. */
export function semanticCheck(cfg: BridgeConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const issue = (path: ConfigIssue['path'], message: string) => issues.push({ path, message });
  const agentNames = new Set(Object.keys(cfg.agents));
  const toolNames = new Set(Object.keys(cfg.tools));
  const people = new Set(Object.keys(cfg.people));

  for (const [section, names] of [['agents', agentNames], ['tools', toolNames]] as const) {
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) issue([section, name], `name "${name}" may only use letters, digits, "-" and "_"`);
    }
  }
  for (const name of agentNames) {
    if (toolNames.has(name)) issue(['tools', name], `"${name}" is both an agent and a tool`);
  }

  cfg.routes.forEach((route, i) => {
    const where = ['routes', i];
    const from = parseAddress(route.from);
    const targets = Array.isArray(route.to) ? route.to : [route.to];

    if (from.kind === 'im') {
      if (targets.length !== 1) issue([...where, 'to'], 'a route from IM must go to exactly one agent');
      const target = targets[0]!;
      const agent = Object.hasOwn(cfg.agents, target) ? cfg.agents[target] : undefined;
      if (!agent) {
        issue([...where, 'to'], `unknown agent "${target}"`);
        return;
      }
      if (from.platform !== 'local' && !Object.hasOwn(cfg.im, from.platform)) {
        issue([...where, 'from'], `IM "${from.platform}" is not configured under im:`);
      }
      // Agents running on this machine are only reachable by people named in the route.
      if (agent.type !== 'webhook' && route.when.sender === undefined) {
        issue(where, `"${target}" runs on this machine, so the route needs when.sender (list people, or "anyone" to opt out)`);
      }
      if (typeof route.when.mention === 'string' && route.when.mention !== target) {
        issue([...where, 'when', 'mention'], `when.mention "${route.when.mention}" should name the route's agent "${target}"`);
      }
      const { mention, listen } = route.when;
      if ((listen === 'all' && mention !== undefined && mention !== false) || (listen === 'mention' && mention === false)) {
        issue([...where, 'when'], `when.listen "${listen}" contradicts when.mention ${JSON.stringify(mention)}`);
      }
    } else {
      if (!agentNames.has(from.name)) issue([...where, 'from'], `from "${route.from}" is not an agent`);
      if (route.when.mention !== undefined || route.when.listen !== undefined) {
        issue([...where, 'when'], 'mention/listen only apply to routes from IM');
      }
      for (const t of targets) {
        const head = t.split('.')[0]!;
        if (!agentNames.has(head) && !toolNames.has(head) && head !== '*') issue([...where, 'to'], `unknown target "${t}"`);
      }
    }

    if (Array.isArray(route.when.sender)) {
      for (const p of route.when.sender) if (!people.has(p)) issue([...where, 'when', 'sender'], `unknown person "${p}"`);
    }
  });

  cfg.policies.forEach((p, i) => {
    const where = ['policies', i];
    for (const who of p.approve_by ?? []) {
      if (who === 'initiator') continue;
      if (!people.has(who)) issue([...where, 'approve_by'], `"${who}" is neither "initiator" nor a person`);
      else if (cfg.people[who]!.trust === 'external') issue([...where, 'approve_by'], `"${who}" has trust external and can't approve`);
    }
    // Hop limits and budgets belong to an agent (and its conversation), not to a single tool call.
    if ((p.max_hops !== undefined || p.budget_usd !== undefined) && (p.match.tool !== undefined || p.match.writes !== undefined)) {
      issue(where, 'max_hops / budget_usd apply per agent — match them by agent only, not by tool or writes');
    }
  });

  cfg.tests.forEach((t, i) => {
    if ('from' in t) {
      const from = parseAddress(t.from);
      if (from.kind !== 'im') issue(['tests', i, 'from'], `"${t.from}" is not an IM address (slack:#dev, feishu:dm, …)`);
      if (t.expect !== 'none' && !agentNames.has(t.expect)) issue(['tests', i, 'expect'], `"${t.expect}" is neither an agent nor "none"`);
    } else if (!agentNames.has(t.agent)) {
      issue(['tests', i, 'agent'], `unknown agent "${t.agent}"`);
    }
  });

  return issues;
}

/** Run the file's `tests` against its own routes. */
export function runTests(cfg: BridgeConfig): ConfigIssue[] {
  const router = new Router(cfg);
  const issues: ConfigIssue[] = [];
  cfg.tests.forEach((t, i) => {
    if ('from' in t) {
      const from = parseAddress(t.from);
      if (from.kind !== 'im') return;
      const personId = t.sender === undefined ? undefined : personFor(cfg, from.platform, t.sender);
      const userId = personId ? ((cfg.people[personId] as Record<string, unknown>)[from.platform] as string | undefined) ?? personId : t.sender ?? 'unknown';
      const isDM = from.channel === 'dm';
      const channel = from.channel.replace(/^#/, '');
      const { match, trace } = router.explainInbound(
        { platform: from.platform, channelId: channel, channelName: isDM ? 'dm' : channel, isDM, userId, text: t.text, mentioned: t.mention, threadId: '1', messageId: '1' },
        { personId },
      );
      const got = match?.agent ?? 'none';
      if (got !== t.expect) {
        const why = match ? `routes[${match.index}] sends it to ${got}` : trace.at(-2) ?? 'no route matched';
        issues.push({ path: ['tests', i], message: `expected ${t.expect}, got ${got} (${why})` });
      }
    } else {
      const route = router.allowsOutbound(t.agent, t.calls);
      const got = route ? 'allow' : 'deny';
      if (got !== t.expect) {
        const why = route ? `routes[${cfg.routes.indexOf(route)}] allows it` : 'no route allows it';
        issues.push({ path: ['tests', i], message: `${t.agent} → ${t.calls}: expected ${t.expect}, got ${got} (${why})` });
      }
    }
  });
  return issues;
}

/** A person id, or the person whose id on `platform` is `sender`. */
function personFor(cfg: BridgeConfig, platform: string, sender: string): string | undefined {
  if (Object.hasOwn(cfg.people, sender)) return sender;
  return Object.entries(cfg.people).find(([, p]) => (p as Record<string, unknown>)[platform] === sender)?.[0];
}

/** Credentials written into the file instead of referenced (`secret:name`, `env:NAME`, `${secret:name}`). */
function literalSecrets(value: unknown, path: (string | number)[] = []): ConfigIssue[] {
  if (typeof value === 'string') {
    return looksLikeSecret(value)
      ? [{ path, message: 'looks like a credential: store it with "bridge secret set <name>" and write secret:<name> here' }]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => literalSecrets(v, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => literalSecrets(v, [...path, k]));
  return [];
}

/** The line of the deepest node on `path` that exists in the file. */
function lineOf(doc: Document, lines: LineCounter, path: (string | number)[]): number | undefined {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
    if (node && typeof node === 'object' && 'range' in node && Array.isArray(node.range)) {
      // A key's whole block starts at its value; point at the key line instead for maps and lists.
      const offset = isMap(node) || isSeq(node) ? keyOffset(doc, path.slice(0, n)) ?? node.range[0] : node.range[0];
      return lines.linePos(offset).line;
    }
  }
  return undefined;
}

function keyOffset(doc: Document, path: (string | number)[]): number | undefined {
  if (!path.length) return undefined;
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find((p) => (p.key as { value?: unknown } | null)?.value === path.at(-1));
  const key = pair?.key as { range?: [number, number, number] } | undefined;
  return key?.range?.[0];
}

function isKey(k: PropertyKey): k is string | number {
  return typeof k === 'string' || typeof k === 'number';
}

function formatPath(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i ? `.${p}` : p)).join('');
}
