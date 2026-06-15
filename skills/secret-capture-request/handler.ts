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

export class SecretCaptureRequestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.secretCapture) {
      return { success: false, error: 'secret-capture-request requires the secretCapture capability in context.' };
    }

    const { secret_name, label, value_format, resume_intent } = ctx.input as {
      secret_name?: unknown;
      label?: unknown;
      value_format?: unknown;
      resume_intent?: unknown;
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

    // Capture the origin routing context (#972) so that when the user fills the link, the
    // capture endpoint can re-enter THIS agent in THIS conversation to continue. Holds no
    // secret material — only routing + the agent's own description of what it's doing. The
    // originator is forwarded opaquely from the task metadata so the resumed task is attributed
    // to whoever started the chain. resume_intent falls back to the label when not supplied.
    const resumeIntent = typeof resume_intent === 'string' && resume_intent.trim()
      ? resume_intent.trim()
      : labelStr;
    const originator = ctx.taskMetadata?.originator as Record<string, unknown> | undefined;

    try {
      const { rawToken, secretName, expiresAt } = await ctx.secretCapture.mintUserSecret({
        rawName: secret_name,
        label: labelStr,
        valueFormat,
        origin: {
          conversationId: ctx.conversationId,
          channelId: ctx.channelId,
          agentId: ctx.agentId,
          taskEventId: ctx.taskEventId,
          originator,
          resumeIntent,
        },
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
            `the value the user types into the form, which goes straight to the vault under ` +
            `"${secretName}" and never reaches you.) Tell them it is one-time and expires in 30 minutes.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'secret-capture-request failed');
      return { success: false, error: message };
    }
  }
}
