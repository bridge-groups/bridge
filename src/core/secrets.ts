/**
 * Turns a credential reference from the config into its value: `secret:<name>`, `env:<NAME>`, or a literal.
 * The embedding app decides where secrets live; it throws when one is missing.
 */
export type SecretResolver = (ref: string) => string;

/** The environment variable a `secret:<name>` reference falls back to. */
export function secretEnvName(name: string): string {
  return `BRIDGE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Secrets from the environment only: `env:NAME`, and `secret:name` as BRIDGE_SECRET_NAME. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return (ref) => {
    if (ref.startsWith('env:')) {
      const name = ref.slice(4);
      const v = env[name];
      if (!v) throw new Error(`environment variable ${name} is not set`);
      return v;
    }
    if (ref.startsWith('secret:')) {
      const name = secretEnvName(ref.slice(7));
      const v = env[name];
      if (!v) throw new Error(`secret "${ref.slice(7)}" not found — set ${name}`);
      return v;
    }
    return ref;
  };
}

/** A value that is a secret ref ("secret:x" / "env:X"), or a string with ${secret:x} / ${env:X} inside. */
export function resolveTemplate(value: string, resolve: SecretResolver): string {
  if (/\$\{(secret|env):[^}]+\}/.test(value)) {
    return value.replace(/\$\{((?:secret|env):[^}]+)\}/g, (_, ref: string) => resolve(ref));
  }
  return resolve(value);
}

/** Every `env:` reference in a value (whole ref or ${env:X} inside a template). */
export function envRefs(value: string): string[] {
  if (value.startsWith('env:')) return [value.slice(4)];
  return [...value.matchAll(/\$\{env:([^}]+)\}/g)].map((m) => m[1]!);
}
