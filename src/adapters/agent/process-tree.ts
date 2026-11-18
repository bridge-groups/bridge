import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** How long a stopped agent process (and the commands it started) gets after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5000;

/**
 * The process groups of `pid` and of every process descended from it. A tool runner such as Claude Code puts each
 * command in a group of its own, so signalling the agent's group alone would miss them. A process that detached
 * itself (`nohup … &` whose parent has exited, `setsid`) is no longer a descendant and is not found.
 */
async function processGroups(pid: number): Promise<number[]> {
  const table = await new Promise<string>((resolve) =>
    // Without a process table only the agent's own group (it is spawned detached, so the group id is its pid) is known.
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out)),
  );
  const children = new Map<number, number[]>();
  const groupOf = new Map<number, number>();
  for (const line of table.split('\n')) {
    const [p, pp, g] = line.trim().split(/\s+/).map(Number);
    if (!p || pp === undefined || !g) continue;
    groupOf.set(p, g);
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  const own = groupOf.get(process.pid);
  const groups = new Set<number>([pid]);
  const todo = [pid];
  for (let p = todo.pop(); p !== undefined; p = todo.pop()) {
    const g = groupOf.get(p);
    if (g !== undefined) groups.add(g);
    todo.push(...(children.get(p) ?? []));
  }
  // Never the bridge's own group, nor init's.
  return [...groups].filter((g) => g > 1 && g !== own);
}

/**
 * End `pid` (spawned detached, so it leads its own group) and every command it started: SIGTERM to each group,
 * then SIGKILL to the groups still there once `exited` has resolved or the grace period is over, whichever is
 * later for the commands and whichever is first for the agent. Resolves once `exited` has resolved.
 */
export async function terminateTree(pid: number, exited: Promise<void>, graceMs = KILL_GRACE_MS): Promise<void> {
  const deadline = Date.now() + graceMs;
  const groups = await processGroups(pid);
  for (const g of groups) signalGroup(g, 'SIGTERM');
  const gone = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)]);
  if (!gone) signalGroup(pid, 'SIGKILL');
  // The agent may exit on SIGTERM without waiting for its commands: they get the rest of the grace period.
  if (groups.some(groupExists)) {
    const left = deadline - Date.now();
    if (left > 0) await delay(left);
    for (const g of groups) if (groupExists(g)) signalGroup(g, 'SIGKILL');
  }
  await exited;
}

function signalGroup(group: number, signal: NodeJS.Signals) {
  try {
    process.kill(-group, signal);
  } catch {
    /* the group is gone */
  }
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: someone else's processes now — not ours to signal.
    return false;
  }
}
