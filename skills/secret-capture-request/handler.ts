// handler.ts — secret-capture-request skill (#971, #1497).
//
// Mints a one-time tokenized link the user clicks to enter a personal secret. The name
// is resolved to a canonical `user.*` key (with fingerprint dedup against existing
// keys) by the minter, so this skill structurally cannot target a system/channel/
// protected key and will not fork a second slug for the same secret. The skill
// returns ONLY the link — it has no code path that reads a value, which is the
// structural form of the "LLM never sees secrets" guarantee.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { CaptureTemplate, CaptureValueFormat } from '../../src/secrets/secret-capture-service.js';
import { deriveCardLabel, normalizeCardLabel } from '../../src/secrets/structured-secret-schema.js';
import { buildCaptureOrigin } from '../../src/secrets/build-capture-origin.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { hasUserSecretDetails, parseUserSecretDetails, type UserSecretDetails } from '../../src/secrets/user-secret-details.js';

/** Build the operator-facing magic-link URL. Prod uses ctx.appOrigin; dev falls back to the
 *  local SPA origin (Fastify serves the built console on httpPort). */
function buildCaptureUrl(ctx: ToolContext, rawToken: string): string {
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

/** Validate the optional template input (#1358). */
function parseTemplate(input: unknown): CaptureTemplate | undefined {
  if (input === undefined || input === null) return undefined;
  if (input === 'credit_card' || input === 'credit_card_renewal') return input;
  throw new Error(`template must be 'credit_card' or 'credit_card_renewal', got '${String(input)}'.`);
}

export class SecretCaptureRequestHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.secretCapture) {
      return { success: false, error: 'secret-capture-request requires the secretCapture capability in context.' };
    }

    const {
      secret_name, label, value_format, resume_intent, login_url, username, details_only,
      template, card_label, expiry_month, expiry_year, cardholder_name, billing_zip,
    } = ctx.input as {
      secret_name?: unknown;
      label?: unknown;
      value_format?: unknown;
      resume_intent?: unknown;
      login_url?: unknown;
      username?: unknown;
      details_only?: unknown;
      template?: unknown;
      card_label?: unknown;
      expiry_month?: unknown;
      expiry_year?: unknown;
      cardholder_name?: unknown;
      billing_zip?: unknown;
    };

    if (typeof secret_name !== 'string' || secret_name.trim().length === 0) {
      return { success: false, error: 'secret_name is required and must be a non-empty string.' };
    }

    // Non-secret sign-in details (#2201): stored beside the key, returned by list-user-secrets.
    let details: UserSecretDetails;
    try {
      details = parseUserSecretDetails({ login_url, username });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Non-secret card fields (#1358). There is deliberately no input for the number or the
    // security code: they are typed into the form, never through the agent.
    const cardEdit: Record<string, unknown> = {};
    if (card_label !== undefined && card_label !== null) cardEdit.label = card_label;
    if (expiry_month !== undefined && expiry_month !== null) cardEdit.expiry_month = expiry_month;
    if (expiry_year !== undefined && expiry_year !== null) cardEdit.expiry_year = expiry_year;
    if (cardholder_name !== undefined && cardholder_name !== null) cardEdit.cardholder_name = cardholder_name;
    if (billing_zip !== undefined) cardEdit.billing_zip = billing_zip; // null clears it
    const hasCardEdit = Object.keys(cardEdit).length > 0;

    let captureTemplate: CaptureTemplate | undefined;
    try {
      captureTemplate = parseTemplate(template);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (details_only === true && hasCardEdit) {
      if (hasUserSecretDetails(details)) {
        return { success: false, error: 'Pass either sign-in details (login_url, username) or card fields, not both.' };
      }
      try {
        const { secretName } = await ctx.secretCapture.setUserCardPublic(secret_name, cardEdit);
        return {
          success: true,
          data: {
            secret_name: secretName,
            details_saved: true,
            summary: `Saved the card details for "${secretName}". No link was minted; the card number and security code are unchanged.`,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ err }, 'secret-capture-request: card details_only update failed');
        return { success: false, error: message };
      }
    }

    if (details_only === true) {
      // Record details on an already-stored key; no link, so the user isn't asked to re-enter it.
      if (!hasUserSecretDetails(details)) {
        return { success: false, error: 'details_only needs login_url, username, or both.' };
      }
      try {
        const { secretName } = await ctx.secretCapture.setUserSecretDetails(secret_name, details);
        return {
          success: true,
          data: {
            secret_name: secretName,
            details_saved: true,
            summary: `Saved the sign-in details for "${secretName}". No link was minted; the stored secret is unchanged.`,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ err }, 'secret-capture-request: details_only update failed');
        return { success: false, error: message };
      }
    }

    // The form collects expiry, name and ZIP itself, so on a new link only the label is ours.
    if (hasCardEdit && !captureTemplate) {
      return { success: false, error: 'Card fields (card_label, expiry_month, expiry_year, cardholder_name, billing_zip) need template or details_only.' };
    }
    if (captureTemplate && (cardEdit.expiry_month !== undefined || cardEdit.expiry_year !== undefined
      || cardEdit.cardholder_name !== undefined || cardEdit.billing_zip !== undefined)) {
      return { success: false, error: 'The card form collects the expiry, name and postal code itself. Only card_label can be set on a link.' };
    }

    // Sign-in details would be upserted onto the card's key, beside its card fields.
    if (captureTemplate && hasUserSecretDetails(details)) {
      return { success: false, error: 'A card link takes either sign-in details or card fields: login_url and username are not allowed with template.' };
    }

    // Card links carry the card label; a renewal uses the saved card's own label (the minter fills it).
    let cardLabel: string | undefined;
    let labelDerived = false;
    if (captureTemplate === 'credit_card') {
      if (cardEdit.label !== undefined) {
        const given = normalizeCardLabel(cardEdit.label);
        if (given === null) return { success: false, error: 'card_label must be 1 to 100 characters.' };
        cardLabel = given;
      } else {
        cardLabel = deriveCardLabel(secret_name) ?? undefined;
        labelDerived = true;
      }
    }
    const labelStr = captureTemplate
      ? cardLabel
      : typeof label === 'string' && label.trim() ? label.trim() : secret_name.trim();

    let valueFormat: CaptureValueFormat;
    try {
      valueFormat = captureTemplate ? 'json' : parseValueFormat(value_format);
    } catch (err) {
      ctx.log.warn({ err, value_format }, 'secret-capture-request: invalid value_format');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // resume_intent falls back to the label when not supplied.
    const resumeIntent = typeof resume_intent === 'string' && resume_intent.trim()
      ? resume_intent.trim()
      : labelStr ?? secret_name.trim();

    // Build the capture origin via the shared helper (#995): re-enter this agent directly when
    // coordinator-minted, or retarget at the coordinator with a resume_token when this skill runs
    // as a delegated specialist. Holds no secret value.
    const origin = buildCaptureOrigin(ctx, resumeIntent);

    try {
      const { rawToken, secretName, expiresAt, reusedExisting } = await ctx.secretCapture.mintUserSecret({
        rawName: secret_name,
        ...(labelStr !== undefined ? { label: labelStr } : {}),
        valueFormat,
        origin,
        ...(captureTemplate ? { template: captureTemplate } : {}),
        ...(labelDerived ? { labelDerived } : {}),
        ...(hasUserSecretDetails(details) ? { details } : {}),
      });
      const captureUrl = buildCaptureUrl(ctx, rawToken);
      const expiresLocal = toLocalIso(Math.floor(expiresAt.getTime() / 1000), ctx.timezone);
      const reuseNote = captureTemplate === 'credit_card_renewal'
        ? `The form asks only for the new expiry and security code; the saved card "${secretName}" keeps its number.`
        : captureTemplate === 'credit_card'
          ? `The form takes the card number, expiry, security code and name; the card is saved under "${secretName}".`
          : reusedExisting
            ? `This updates the existing vault key "${secretName}" in place rather than creating a new one.`
            : `The value is stored under "${secretName}".`;

      return {
        success: true,
        data: {
          capture_url: captureUrl,
          expires_at: expiresLocal,
          secret_name: secretName,
          reused_existing: reusedExisting === true,
          displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone, new Date()) : undefined,
          summary:
            `Reply to the user with the capture_url EXACTLY as given, including the full token — ` +
            `do not redact, mask, shorten, or alter any part of it, and do not replace it with ` +
            `a placeholder. The link itself is safe to share; it is not a secret. (The secret is ` +
            `the value the user types into the form, which goes straight to the vault and never ` +
            `reaches you.) ${reuseNote} Tell them it is one-time and expires in 30 minutes.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'secret-capture-request failed');
      return { success: false, error: message };
    }
  }
}
