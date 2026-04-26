// handler.test.ts — image-generate skill unit tests.
//
// All tests mock global fetch() so no real API calls are made.
// The handler reads the API key via ctx.secret(), which we provide
// as a simple function returning a fixed test key.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageGenerateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

// A minimal SkillContext factory. image-generate needs:
//   ctx.input    — the skill inputs
//   ctx.secret() — returns the API key
//   ctx.log      — pino logger (silenced)
function makeCtx(
  input: Record<string, unknown>,
  secretValue = 'test-api-key',
): SkillContext {
  return {
    input,
    secret: (_name: string) => secretValue,
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
}

// Minimal OpenAI Images API response shape.
function makeOpenAIResponse(url: string, revisedPrompt?: string) {
  return {
    data: [
      {
        url,
        ...(revisedPrompt !== undefined && { revised_prompt: revisedPrompt }),
      },
    ],
  };
}

describe('ImageGenerateHandler', () => {
  let handler: ImageGenerateHandler;

  beforeEach(() => {
    handler = new ImageGenerateHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when prompt is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/prompt/i);
  });

  it('returns error when prompt is empty string', async () => {
    const ctx = makeCtx({ prompt: '' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/prompt/i);
  });

  it('returns error when API key is not configured', async () => {
    const ctx = makeCtx({ prompt: 'a red fox' }, '');
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/api key/i);
  });

  it('calls OpenAI with correct defaults when optional inputs are omitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeOpenAIResponse('https://example.com/image.png')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({ prompt: 'a mountain at sunset' });
    await handler.execute(ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('dall-e-3');
    expect(body.prompt).toBe('a mountain at sunset');
    expect(body.size).toBe('1792x1024');
    expect(body.quality).toBe('hd');
    expect(body.style).toBe('vivid');
    expect(body.n).toBe(1);
  });

  it('trims whitespace from prompt before sending to OpenAI', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeOpenAIResponse('https://example.com/image.png')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({ prompt: '  a mountain at sunset  ' });
    await handler.execute(ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.prompt).toBe('a mountain at sunset');
  });

  it('respects size, quality, and style overrides', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeOpenAIResponse('https://example.com/image.png')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({
      prompt: 'abstract art',
      size: '1024x1024',
      quality: 'standard',
      style: 'natural',
    });
    await handler.execute(ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('standard');
    expect(body.style).toBe('natural');
  });

  it('returns error for invalid size', async () => {
    const ctx = makeCtx({ prompt: 'anything', size: '512x512' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid size/i);
  });

  it('returns error for invalid quality', async () => {
    const ctx = makeCtx({ prompt: 'anything', quality: 'ultra' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid quality/i);
  });

  it('returns error for invalid style', async () => {
    const ctx = makeCtx({ prompt: 'anything', style: 'cartoon' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid style/i);
  });

  it('returns url and revised_prompt on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify(makeOpenAIResponse(
          'https://oai.cdn.example.com/abc123.png',
          'A warm golden mountain at dusk',
        )),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({ prompt: 'mountain at sunset' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { url: string; revised_prompt?: string };
      expect(data.url).toBe('https://oai.cdn.example.com/abc123.png');
      expect(data.revised_prompt).toBe('A warm golden mountain at dusk');
    }
  });

  it('returns url without revised_prompt when OpenAI omits it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ url: 'https://oai.cdn.example.com/xyz.png' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({ prompt: 'a simple shape' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { url: string; revised_prompt?: string };
      expect(data.url).toBe('https://oai.cdn.example.com/xyz.png');
      expect(data.revised_prompt).toBeUndefined();
    }
  });

  it('returns error on non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
        { status: 429, statusText: 'Too Many Requests' },
      ),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/429/);
      expect(result.error).toMatch(/rate limit/i);
    }
  });

  it('returns error when fetch throws (network failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/request failed/i);
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it('returns error when response JSON is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not json', { status: 200 }),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
  });

  it('returns error when response data array is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no image/i);
  });
});
