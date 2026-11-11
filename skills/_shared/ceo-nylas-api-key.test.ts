import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext } from '../../src/skills/types.js';
import { ceoNylasApiKey, CHANNEL_NYLAS_API_KEY } from './ceo-nylas-api-key.js';

/** A ctx whose secret() behaves like the execution layer's for declared names. */
function ctxWith(values: Record<string, string>, failing?: Error): ToolContext {
  return {
    secret(name: string) {
      if (failing) throw failing;
      const value = values[name];
      if (value !== undefined) return value;
      throw new Error(`Secret '${name}' is declared but not set in the environment`);
    },
  } as unknown as ToolContext;
}

describe('ceoNylasApiKey', () => {
  it('reads the key the console saves, trimmed', () => {
    expect(ceoNylasApiKey(ctxWith({ [CHANNEL_NYLAS_API_KEY]: ' console ' }))).toBe('console');
  });

  it('ignores the retired flat nylas_api_key (#2522)', () => {
    expect(() => ceoNylasApiKey(ctxWith({ nylas_api_key: 'legacy' }))).toThrow(/declared but not set/);
  });

  it('throws the absent-secret error when the key is blank', () => {
    expect(() => ceoNylasApiKey(ctxWith({ [CHANNEL_NYLAS_API_KEY]: '  ' }))).toThrow(/declared but not set/);
  });

  it('throws the absent-secret error when the key is not set', () => {
    expect(() => ceoNylasApiKey(ctxWith({}))).toThrow(/declared but not set/);
  });

  it('propagates a vault failure', () => {
    const failing = new Error("Vault read failed for secret 'channel.email.nylas_api_key'");
    expect(() => ceoNylasApiKey(ctxWith({}, failing))).toThrow(/Vault read failed/);
  });

  it('every ceo-inbox tool that calls it declares the key, and none the retired flat name', () => {
    const toolsDir = join(import.meta.dirname, '../ceo-inbox/tools');
    const callers = readdirSync(toolsDir).filter(tool => {
      const handler = join(toolsDir, tool, 'handler.ts');
      return existsSync(handler) && readFileSync(handler, 'utf-8').includes('ceoNylasApiKey(');
    });
    expect(callers.length).toBeGreaterThan(0);
    for (const tool of callers) {
      const manifest = JSON.parse(readFileSync(join(toolsDir, tool, 'tool.json'), 'utf-8')) as { secrets: string[] };
      expect(manifest.secrets, tool).toContain(CHANNEL_NYLAS_API_KEY);
    }
    for (const tool of readdirSync(toolsDir)) {
      const path = join(toolsDir, tool, 'tool.json');
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, 'utf-8')) as { secrets?: string[] };
      expect(manifest.secrets ?? [], tool).not.toContain('nylas_api_key');
    }
  });
});
