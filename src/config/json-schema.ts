import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BridgeConfig } from './schema.ts';

/** The JSON Schema of bridge.yaml (what may be written: defaults make keys optional). */
export function configJsonSchema(): string {
  const schema = z.toJSONSchema(BridgeConfig, { io: 'input', unrepresentable: 'any' });
  return JSON.stringify({ ...schema, title: 'bridge.yaml' }, null, 2) + '\n';
}

/** The copy shipped in doc/, which bridge.yaml files point their editors and agents at; resolves from src/ and out/. */
export const SCHEMA_FILE = fileURLToPath(new URL('../../doc/bridge.schema.json', import.meta.url));
