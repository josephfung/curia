// handler.ts — image-generate skill implementation.
//
// Wraps the OpenAI Images API (DALL-E 3) to generate a single image from a text
// prompt. Returns a temporary CDN URL — callers must download and persist the
// image immediately; OpenAI expires the URL after approximately one hour.
//
// Defaults tuned for essay cover art (widescreen, high quality, vivid style).
// All three are overridable so the skill is useful for other agents too.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/images/generations';

const VALID_SIZES = new Set(['1024x1024', '1792x1024', '1024x1792']);
const VALID_QUALITIES = new Set(['standard', 'hd']);
const VALID_STYLES = new Set(['vivid', 'natural']);

interface OpenAIImageItem {
  url?: string;
  revised_prompt?: string;
}

interface OpenAIImagesResponse {
  data?: OpenAIImageItem[];
}

export class ImageGenerateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { prompt, size, quality, style } = ctx.input as {
      prompt?: string;
      size?: string;
      quality?: string;
      style?: string;
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

    // Apply defaults; reject unknown values to surface misconfiguration early
    const resolvedSize = size ?? '1792x1024';
    const resolvedQuality = quality ?? 'hd';
    const resolvedStyle = style ?? 'vivid';

    if (!VALID_SIZES.has(resolvedSize)) {
      return { success: false, error: `Invalid size: ${resolvedSize}. Must be one of: 1024x1024, 1792x1024, 1024x1792` };
    }
    if (!VALID_QUALITIES.has(resolvedQuality)) {
      return { success: false, error: `Invalid quality: ${resolvedQuality}. Must be: standard or hd` };
    }
    if (!VALID_STYLES.has(resolvedStyle)) {
      return { success: false, error: `Invalid style: ${resolvedStyle}. Must be: vivid or natural` };
    }

    ctx.log.info({ promptLength: prompt.length, size: resolvedSize, quality: resolvedQuality }, 'Generating image via DALL-E 3');

    let response: Response;
    try {
      response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Bearer token — never logged, never passed through LLM context
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt.trim(),
          n: 1,
          size: resolvedSize,
          quality: resolvedQuality,
          style: resolvedStyle,
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
    if (!item?.url) {
      ctx.log.error({ body }, 'OpenAI response missing image URL');
      return { success: false, error: 'No image URL in OpenAI response — unexpected response shape' };
    }

    ctx.log.info('Image generated successfully');

    return {
      success: true,
      data: {
        url: item.url,
        // revised_prompt is set when DALL-E 3 rewrites the prompt for safety/quality;
        // pass it through so callers can log or display what was actually used
        ...(item.revised_prompt !== undefined && { revised_prompt: item.revised_prompt }),
      },
    };
  }
}
