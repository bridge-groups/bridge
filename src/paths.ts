import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the `bridge` command keeps things (the library takes every location from the app). */

/** The config: $XDG_CONFIG_HOME/bridge/bridge.yaml, else ~/.config/bridge/bridge.yaml (`-c` names another). */
export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bridge', 'bridge.yaml');

/**
 * Your data: the conversation database and audit trail (unless `server.data_dir` says otherwise), the record of
 * the config applied last, conversation worktrees.
 */
export const DATA_DIR = join(homedir(), '.bridge');

/** Temporary files: attachments (kept for `files_ttl` at most; the system may clear them sooner), agent scratch. */
export const TEMP_DIR = '/tmp/bridge';
