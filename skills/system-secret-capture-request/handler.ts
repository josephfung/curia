// handler.ts — system-secret-capture-request skill (#971).
//
// Sibling of secret-capture-request, differing only in name policy and access control:
//   - Name policy: the target must be a DECLARED skill secret or a known channel credential
//     key (the same allowlist the vault PUT route enforces), used verbatim as the vault key.
//   - Access: allowed_callers ["setup-wizard"] — runnable only during onboarding, which is
//     principal-originated. The execution layer enforces this; it is not a prompt convention.
// Like its sibling, it returns ONLY the link and has no code path that reads a value.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { CaptureValueFormat } from '../../src/secrets/secret-capture-service.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

/** Build the operator-facing magic-link URL. Prod uses ctx.appOrigin; dev falls back to the
 *  local SPA origin (Fastify serves the built console on httpPort). */
function buildCaptureUrl(ctx: SkillContext, rawToken: string): string {
  // Trim any trailing slash so a configured appOrigin like "https://host/" doesn't yield a
  // "//secret-capture/..." path that breaks SPA route matching.
  const origin = (ctx.appOrigin ?? `http://localhost:${ctx.httpPort ?? 3000}`).replace(/\/+$/, '');
  return `${origin}/secret-capture/${rawToken}`;
}

/** Validate the optional value_format input, defaulting to 'string'. */
function parseValueFormat(input: unknown): CaptureValueFormat {
  if (input === undefined || input === null) return 'string';
  if (input === 'string' || input === 'json') return input;
  throw new Error(`value_format must be 'string' or 'json', got '${String(input)}'.`);
}

export class SystemSecretCaptureRequestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.secretCapture) {
      return { success: false, error: 'system-secret-capture-request requires the secretCapture capability in context.' };
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
      ctx.log.warn({ err, value_format }, 'system-secret-capture-request: invalid value_format');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const { rawToken, secretName, expiresAt } = await ctx.secretCapture.mintSystemSecret({
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
            `Reply to the user with the capture_url EXACTLY as given, including the full token — ` +
            `do not redact, mask, shorten, or alter any part of it, and do not replace it with ` +
            `a placeholder. The link itself is safe to share; it is not a secret. (The secret is ` +
            `the value the user types into the form for "${secretName}", which goes straight to the ` +
            `vault and never reaches you.) Tell them it is one-time and expires in 30 minutes.`,
        },
      };
    } catch (err) {
      // A rejected name (not a declared/channel key) lands here — surface it so the agent can
      // correct the target rather than silently failing.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'system-secret-capture-request failed');
      return { success: false, error: message };
    }
  }
}
