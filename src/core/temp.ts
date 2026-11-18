import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the bridge keeps temporary files when the app names no other place. */
export const DEFAULT_TEMP_DIR = join(tmpdir(), 'bridge');

/**
 * `dir`, created if needed and readable by this user only. Temporary files hold chat attachments and agent
 * settings, and a shared folder like /tmp lets anyone create a path first: a symlink, or a folder owned by someone
 * else, is refused instead of used.
 */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder (a symlink?) — remove it, then try again`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user — remove it, then try again`);
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}
