import { execFileSync } from 'node:child_process';
import { envSecrets, secretEnvName, type SecretResolver } from './core/secrets.ts';

/** Keychain service name for every secret the bridge stores. */
const SERVICE = 'dev.bridge';
/** `security` exits with this when the item does not exist. */
const NOT_FOUND = 44;

const fromEnv = envSecrets();

/** The CLI's secrets: `secret:<name>` from BRIDGE_SECRET_<NAME> or the OS keychain, `env:<NAME>`, or a literal. */
export const keychainSecrets: SecretResolver = (ref) => {
  if (!ref.startsWith('secret:')) return fromEnv(ref);
  const name = ref.slice(7);
  const v = readSecret(name);
  if (v === undefined) throw new Error(`secret "${name}" not found — run: bridge secret set ${name}  (or set ${secretEnvName(name)})`);
  return v;
};

export function setSecret(name: string, value: string) {
  if (process.platform !== 'darwin') {
    throw new Error(`the keychain is only used on macOS — export ${secretEnvName(name)} instead`);
  }
  // `security -i` takes one command per line; a line break would end the value and start another command.
  if (/[\r\n]/.test(value)) throw new Error('secrets must be a single line');
  if (!value) throw new Error('empty secret');
  // `security -i` reads the command from stdin, so the value never appears in argv (visible to `ps`).
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  const out = execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${q(SERVICE)} -a ${q(name)} -w ${q(value)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `security -i` exits 0 even when a command fails, so check that the value really landed.
  if (keychainRead(name) !== value) {
    throw new Error(`the keychain did not store "${name}"${out.trim() ? `: ${out.trim()}` : ''}`);
  }
}

/** Read a stored secret, or undefined when there is none. Keychain failures (locked, denied) throw. */
export function readSecret(name: string): string | undefined {
  return process.env[secretEnvName(name)] || keychainRead(name);
}

export function deleteSecret(name: string) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
  } catch (err) {
    if ((err as { status?: number }).status !== NOT_FOUND) throw new Error(`could not delete "${name}" from the keychain`);
  }
}

/** The keychain alone (no environment fallback): what a background service will find. */
export function keychainRead(name: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
  } catch (err) {
    if ((err as { status?: number }).status === NOT_FOUND) return undefined;
    const why = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`could not read "${name}" from the keychain${why ? `: ${why}` : ''}`);
  }
}
