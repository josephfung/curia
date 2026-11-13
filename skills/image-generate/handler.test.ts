// handler.test.ts — image-generate skill unit tests.
//
// All tests mock global fetch() so no real API calls are made.
// The handler reads the API key via ctx.secret(), which we provide
// as a simple function returning a fixed test key. GPT Image models
// return base64 image data, so ctx.writeTempFile is mocked to return
// a file:// URL for the stored bytes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageGenerateHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import pino from 'pino';

// A minimal ToolContext factory. image-generate needs:
//   ctx.input         — the skill inputs
//   ctx.secret()      — returns the API key, or throws when secretThrows is true
//   ctx.writeTempFile — stores image bytes, returns a file:// URL;
//                       omitted when tempStore is false
//   ctx.log           — pino logger (silenced)
function makeCtx(
  input: Record<string, unknown>,
  { secretThrows = false, tempStore = true } = {},
): ToolContext {
  return {
    input,
    secret: (name: string) => {
      if (secretThrows) {
        throw new Error(`Secret '${name}' is declared but not set in the environment`);
      }
      return 'test-api-key';
    },
    ...(tempStore && {
      writeTempFile: vi.fn(async (_buffer: Buffer, filename: string) =>
        `file:///tmp/curia-temp/${filename}`),
    }),
    log: pino({ level: 'silent' }),
  } as unknown as ToolContext;
}

// Minimal OpenAI Images API response shapes.
function makeUrlResponse(url: string, revisedPrompt?: string) {
  return {
    data: [
      {
        url,
        ...(revisedPrompt !== undefined && { revised_prompt: revisedPrompt }),
      },
    ],
  };
}

const PNG_BYTES = Buffer.from('fake-png-bytes');
const PNG_B64 = PNG_BYTES.toString('base64');

function makeB64Response(revisedPrompt?: string) {
  return {
    data: [
      {
        b64_json: PNG_B64,
        ...(revisedPrompt !== undefined && { revised_prompt: revisedPrompt }),
      },
    ],
  };
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
    // In production ctx.secret() throws when the env var is unset — mirror that here.
    const ctx = makeCtx({ prompt: 'a red fox' }, { secretThrows: true });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/api key/i);
  });

  it('calls OpenAI with correct defaults when optional inputs are omitted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response()),
    );

    const ctx = makeCtx({ prompt: 'a mountain at sunset' });
    await handler.execute(ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-image-2');
    expect(body.prompt).toBe('a mountain at sunset');
    expect(body.size).toBe('1536x1024');
    expect(body.quality).toBe('high');
    // GPT Image models reject `style` outright (#2326) — it must not be sent.
    expect(body).not.toHaveProperty('style');
    expect(body.n).toBe(1);
  });

  it('trims whitespace from prompt before sending to OpenAI', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response()),
    );

    const ctx = makeCtx({ prompt: '  a mountain at sunset  ' });
    await handler.execute(ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.prompt).toBe('a mountain at sunset');
  });

  it('respects size and quality overrides and never forwards style', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response()),
    );

    // `style` is a DALL-E-era input the manifest no longer advertises; a
    // caller still passing it must not put it back on the wire.
    const ctx = makeCtx({
      prompt: 'abstract art',
      size: '1024x1024',
      quality: 'low',
      style: 'natural',
    });
    await handler.execute(ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('low');
    expect(body).not.toHaveProperty('style');
  });

  it('maps legacy DALL-E quality values to the GPT Image vocabulary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson(makeB64Response()))
      .mockResolvedValueOnce(okJson(makeB64Response()));

    await handler.execute(makeCtx({ prompt: 'one', quality: 'hd' }));
    await handler.execute(makeCtx({ prompt: 'two', quality: 'standard' }));

    const first = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    const second = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(first.quality).toBe('high');
    expect(second.quality).toBe('medium');
  });

  it('passes arbitrary size and quality values through without validation', async () => {
    // size/quality are not validated against an allowlist — the API decides.
    // This allows future model swaps without changing the skill.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response()),
    );

    const ctx = makeCtx({ prompt: 'a red fox', size: '1536x864', quality: 'auto' });
    const result = await handler.execute(ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.size).toBe('1536x864');
    expect(body.quality).toBe('auto');
    expect(result.success).toBe(true);
  });

  it('stores a b64_json response in the temp file store and returns its file URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response('A warm golden mountain at dusk')),
    );

    const ctx = makeCtx({ prompt: 'mountain at sunset' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const writeTempFile = ctx.writeTempFile as unknown as ReturnType<typeof vi.fn>;
    expect(writeTempFile).toHaveBeenCalledOnce();
    const [bytes, filename] = writeTempFile.mock.calls[0] as [Buffer, string];
    expect(bytes.equals(PNG_BYTES)).toBe(true);
    expect(filename).toBe('generated-image.png');

    if (result.success) {
      const data = result.data as { url: string; revised_prompt?: string };
      expect(data.url).toBe('file:///tmp/curia-temp/generated-image.png');
      expect(data.revised_prompt).toBe('A warm golden mountain at dusk');
    }
  });

  it('returns error when a b64_json response arrives without the temp file store', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeB64Response()),
    );

    const ctx = makeCtx({ prompt: 'mountain at sunset' }, { tempStore: false });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/tempFileStore/);
  });

  it('returns url and revised_prompt on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson(makeUrlResponse(
        'https://oai.cdn.example.com/abc123.png',
        'A warm golden mountain at dusk',
      )),
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
      okJson({ data: [{ url: 'https://oai.cdn.example.com/xyz.png' }] }),
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

  it('returns error on non-OK response with non-JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/500/);
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
      okJson({ data: [] }),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no image/i);
  });

  it('returns error when the image item carries neither b64_json nor url', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ data: [{}] }),
    );

    const ctx = makeCtx({ prompt: 'anything' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no image/i);
  });
});
