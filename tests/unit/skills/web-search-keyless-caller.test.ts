// Caller-level check for #2453's keyless flow: once tavily_api_key is gone from the vault
// (and TAVILY_API_KEY is unset), the PRODUCTION secret resolution in ExecutionLayer plus the
// real web-search handler must still search, keyless. The handler's own tests fake
// ctx.secret(), so they cannot catch the execution layer changing its missing-secret error.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import pino from 'pino';
import { discoverToolManifests, loadToolsFromDirectory } from '../../../src/skills/loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import type { SecretsService } from '../../../src/secrets/secrets-service.js';

const logger = pino({ level: 'silent' });

describe('web-search after its key is removed from the vault', () => {
  const savedEnv = process.env['TAVILY_API_KEY'];
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedEnv === undefined) delete process.env['TAVILY_API_KEY'];
    else process.env['TAVILY_API_KEY'] = savedEnv;
  });

  it('searches keyless through the real execution layer', async () => {
    delete process.env['TAVILY_API_KEY'];
    const registry = new ToolRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');
    await loadToolsFromDirectory(discoverToolManifests(skillsDir), registry, logger, new Set(['web-search']));

    const vaultReads: string[] = [];
    // What the vault returns for a deleted key.
    const secretsService = { get: async (name: string) => { vaultReads.push(name); return null; } } as unknown as SecretsService;
    const executionLayer = new ExecutionLayer(registry, logger, { secretsService });

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: 'Example', url: 'https://example.com', content: 'c', score: 0.9 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await executionLayer.invoke('web-search', { query: 'test' });
    expect(result.success).toBe(true);
    expect(vaultReads).toContain('tavily_api_key');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Tavily-Access-Mode']).toBe('keyless');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('api_key');
  });
});
