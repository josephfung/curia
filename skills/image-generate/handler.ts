// handler.ts — image-generate skill implementation.
//
// Wraps the OpenAI Images API (GPT Image) to generate a single image from a
// text prompt. GPT Image models return the image as base64 (`b64_json`) —
// there is no URL response — so the bytes are written to the temp file store
// and the returned `url` is the store's file:// URL. Callers must persist the
// image promptly; the temp store is not durable storage.
//
// Defaults tuned for essay cover art (widescreen, high quality). Both are
// overridable so the skill is useful for other agents too.
//
// History: this skill originally called DALL-E 3, which OpenAI retired on
// 2026-05-12; every production call has failed since (#2326). DALL-E-era
// parameters do not carry over: GPT Image models reject `style` outright
// (the parameter that broke every call) and use different quality/size
// vocabularies, so legacy caller values are mapped below.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-2';

interface OpenAIImageItem {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAIImagesResponse {
  data?: OpenAIImageItem[];
}

// DALL-E 3 quality values callers may still pass, mapped to the GPT Image
// vocabulary (low / medium / high / auto). Anything else passes through —
// validation is the API's responsibility.
const LEGACY_QUALITY_MAP: Record<string, string> = {
  hd: 'high',
  standard: 'medium',
};

export class ImageGenerateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { prompt, size, quality } = ctx.input as {
      prompt?: string;
      size?: string;
      quality?: string;
    };

    // Validate required input
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      return { success: false, error: 'Missing required input: prompt (non-empty string)' };
    }

    // Resolve API key — ctx.secret() throws if the env var is unset or empty,
    // so no further emptiness check is needed after the try/catch.
    let apiKey: string;
    try {
      apiKey = ctx.secret('openai_api_key');
    } catch (err) {
      ctx.log.error({ err }, 'Failed to resolve OpenAI API key');
      return { success: false, error: 'OpenAI API key not configured — set OPENAI_API_KEY in the environment' };
    }

    // Apply defaults in the GPT Image vocabulary. The old DALL-E 3 defaults
    // (size 1792x1024, quality 'hd') map to 1536x1024 and 'high'. No `style`
    // is sent: GPT Image models reject the parameter — describe the desired
    // style in the prompt instead.
    const resolvedSize = size ?? '1536x1024';
    const resolvedQuality = LEGACY_QUALITY_MAP[quality ?? ''] ?? quality ?? 'high';

    ctx.log.info({ promptLength: prompt.length, size: resolvedSize, quality: resolvedQuality }, 'Generating image via GPT Image');

    let response: Response;
    try {
      response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Bearer <redacted> — never logged, never passed through LLM context
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          prompt: prompt.trim(),
          n: 1,
          size: resolvedSize,
          quality: resolvedQuality,
        }),
        // 55s hard timeout — shorter than the manifest's 60s so we have
        // time to surface a clean error before the execution layer kills us
        signal: AbortSignal.timeout(55000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'OpenAI Images API request failed');
      return { success: false, error: `Image generation request failed: ${message}` };
    }

    if (!response.ok) {
      // Try to surface the API's own error message for easier debugging
      let detail = '';
      try {
        const errBody = await response.json() as { error?: { message?: string } };
        detail = errBody?.error?.message ? `: ${errBody.error.message}` : '';
      } catch (parseErr) {
        // Non-JSON error body — common from gateway errors; HTTP status still surfaces to caller
        ctx.log.debug({ parseErr }, 'Could not parse error response body from OpenAI');
      }
      ctx.log.error({ status: response.status, detail }, 'OpenAI Images API returned non-OK status');
      return { success: false, error: `OpenAI API returned HTTP ${response.status}${detail}` };
    }

    let body: OpenAIImagesResponse;
    try {
      body = await response.json() as OpenAIImagesResponse;
    } catch (err) {
      ctx.log.error({ err }, 'Failed to parse OpenAI Images API response as JSON');
      return { success: false, error: 'Failed to parse OpenAI response as JSON' };
    }

    const item = body.data?.[0];
    if (!item?.b64_json && !item?.url) {
      ctx.log.error({ body }, 'OpenAI response missing image data');
      return { success: false, error: 'No image data in OpenAI response — unexpected response shape' };
    }

    // GPT Image models return base64 bytes, not a URL. Write them to the
    // temp file store and hand back its file:// URL, keeping the `url`
    // output callers already consume.
    let url = item.url;
    if (item.b64_json) {
      if (!ctx.writeTempFile) {
        ctx.log.error('image-generate: tempFileStore capability missing — execution layer misconfigured');
        return { success: false, error: 'image-generate requires tempFileStore capability' };
      }
      const bytes = Buffer.from(item.b64_json, 'base64');
      if (bytes.length === 0) {
        ctx.log.error('OpenAI returned empty b64_json image data');
        return { success: false, error: 'No image data in OpenAI response — unexpected response shape' };
      }
      try {
        url = await ctx.writeTempFile(bytes, 'generated-image.png');
      } catch (err) {
        ctx.log.error({ err }, 'Failed to write generated image to temp file store');
        return { success: false, error: 'Failed to store generated image' };
      }
    }

    ctx.log.info('Image generated successfully');

    return {
      success: true,
      data: {
        url,
        // revised_prompt is set when the model rewrites the prompt for
        // safety/quality; pass it through so callers can log or display
        // what was actually used
        ...(item.revised_prompt !== undefined && { revised_prompt: item.revised_prompt }),
      },
    };
  }
}
