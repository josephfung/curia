// handler.ts — secret-capture-request skill (#971).
//
// Mints a one-time tokenized link the user clicks to enter a NEW personal secret. The name
// is auto-namespaced to `user.<slug>` by the minter, so this skill structurally cannot target
// a system/channel/protected key. The skill returns ONLY the link — it has no code path that
// reads a value, which is the structural form of the "LLM never sees secrets" guarantee.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { CaptureValueFormat } from '../../src/secrets/secret-capture-service.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

/** Build the operator-facing magic-link URL. Prod uses ctx.appOrigin; dev falls back to the
 *  local SPA origin (Fastify serves the built console on httpPort). */
function buildCaptureUrl(ctx: SkillContext, rawToken: string): string {
  const origin = ctx.appOrigin ?? `http://localhost:${ctx.httpPort ?? 3000}`;
  return `${origin}/secret-capture/${rawToken}`;
}

/** Validate the optional value_format input, defaulting to 'string'. */
function parseValueFormat(input: unknown): CaptureValueFormat {
  if (input === undefined || input === null) return 'string';
  if (input === 'string' || input === 'json') return input;
  throw new Error(`value_format must be 'string' or 'json', got '${String(input)}'.`);
}

export class SecretCaptureRequestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.secretCapture) {
      return { success: false, error: 'secret-capture-request requires the secretCapture capability in context.' };
    }

    const { secret_name, label, value_format } = ctx.input as {
      secret_name?: unknown;
      label?: unknown;
      value_format?: unknown;
    };

    if (typeof secret_name !== 'string' || secret_name.trim().length === 0) {
      return { success: false, error: 'secret_name is required and must be a non-empty string.' };
    }
    const labelStr = typeof label === 'string' && label.trim() ? label.trim() : secret_name.trim();

    let valueFormat: CaptureValueFormat;
    try {
      valueFormat = parseValueFormat(value_format);
    } catch (err) {
      ctx.log.warn({ err, value_format }, 'secret-capture-request: invalid value_format');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const { rawToken, secretName, expiresAt } = await ctx.secretCapture.mintUserSecret({
        rawName: secret_name,
        label: labelStr,
        valueFormat,
      });
      const captureUrl = buildCaptureUrl(ctx, rawToken);
      const expiresLocal = toLocalIso(Math.floor(expiresAt.getTime() / 1000), ctx.timezone);

      return {
        success: true,
        data: {
          capture_url: captureUrl,
          expires_at: expiresLocal,
          secret_name: secretName,
          displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone, new Date()) : undefined,
          summary:
            `Send this one-time link to the user so they can enter the value. It expires in 30 minutes ` +
            `and works once. The value goes straight to the vault under "${secretName}" — you will not see it.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'secret-capture-request failed');
      return { success: false, error: message };
    }
  }
}
