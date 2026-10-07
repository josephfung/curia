import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { redactArchiveContent, writeLlmCallArchive } from '../../../src/audit/llm-call-archive.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('redactArchiveContent', () => {
  it('redacts sensitive keys and secret-shaped strings', () => {
    const redacted = redactArchiveContent({
      messages: [
        { role: 'user', content: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz012345' },
      ],
      api_key: 'should-not-appear',
      nested: { token: 'secret-token-value' },
    }) as Record<string, unknown>;

    expect(redacted.api_key).toBe('[REDACTED]');
    expect((redacted.nested as Record<string, unknown>).token).toBe('[REDACTED]');
    const content = ((redacted.messages as Array<{ content: string }>)[0]!).content;
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-ant-');
  });

  it('throws on non-plain objects rather than writing them', () => {
    expect(() => redactArchiveContent({ buf: Buffer.from('x') })).toThrow(/non-plain/);
  });
});

describe('writeLlmCallArchive', () => {
  function capturingClient() {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    return { client, queries };
  }

  it('strips null bytes from prompt, response, and tool definitions before insert', async () => {
    const { client, queries } = capturingClient();
    const ok = await writeLlmCallArchive(client, 'evt-1', {
      prompt: { messages: [{ content: 'before\u0000after' }] },
      response: { type: 'text', content: 'ans\u0000wer', reasoning: 'be\u0000cause' },
      toolDefinitions: [{ name: 'fetch', description: 'a\u0000b' }],
    }, createSilentLogger());

    expect(ok).toBe(true);
    const params = queries[0]?.params ?? [];
    const serialized = params.map((param) => typeof param === 'string' ? param : JSON.stringify(param)).join('\n');
    expect(serialized).not.toContain('\u0000');
    expect(serialized).toContain('beforeafter');
    expect(serialized).toContain('answer');
    expect(serialized).toContain('because');
    expect(serialized).toContain('"description":"ab"');
  });

  it('redacts a secret that a null byte had split', async () => {
    const { client, queries } = capturingClient();
    await writeLlmCallArchive(client, 'evt-2', {
      prompt: { text: 'key sk-ant-abc\u0000defghijklmnopqrstuvwxyz012345' },
      response: { type: 'text', content: 'ok' },
    }, createSilentLogger());
    const prompt = String(queries[0]?.params?.[1]);
    expect(prompt).not.toContain('sk-ant-');
    expect(prompt).toContain('[REDACTED]');
  });

  it('drops the reasoning string when includeReasoning is false and keeps the token count', async () => {
    const { client, queries } = capturingClient();
    await writeLlmCallArchive(client, 'evt-3', {
      prompt: { text: 'hi' },
      response: {
        type: 'text',
        content: 'ok',
        reasoning: 'private chain of thought',
        reasoningTokens: 9,
        reasoningOmitted: 'empty',
      },
    }, createSilentLogger(), { includeReasoning: false });
    const response = String(queries[0]?.params?.[2]);
    expect(response).not.toContain('private chain of thought');
    expect(response).toContain('"reasoningTokens":9');
    expect(response).toContain('"reasoningOmitted":"empty"');
  });
});
