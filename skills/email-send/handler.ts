// handler.ts — email-send skill implementation.
//
// Sends a new email via the Nylas API. This is an infrastructure skill —
// it requires nylasClient access in its context. Recipient addresses are
// provided as a comma-separated string and parsed into the array format
// Nylas expects.
//
// sensitivity: "elevated" — this skill has real-world side effects (sends
// actual email). No approval flow exists yet; the flag is informational.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Input length limits — prevent oversized payloads reaching the email API
const MAX_TO_LENGTH = 1000;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;

/**
 * Parse a comma-separated list of email addresses into the array format
 * that Nylas expects: `[{ email: string }]`. Trims whitespace from each
 * address. Skips empty segments (e.g., trailing comma).
 */
function parseRecipients(raw: string): Array<{ email: string }> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((email) => ({ email }));
}

export class EmailSendHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { to, cc, subject, body } = ctx.input as {
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
    };

    // Validate required inputs
    if (!to || typeof to !== 'string') {
      return { success: false, error: 'Missing required input: to (string)' };
    }
    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    // Length limits
    if (to.length > MAX_TO_LENGTH) {
      return { success: false, error: `to must be ${MAX_TO_LENGTH} characters or fewer` };
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return { success: false, error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer` };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    // Parse recipients
    const toRecipients = parseRecipients(to);
    if (toRecipients.length === 0) {
      return { success: false, error: 'to field contains no valid email addresses' };
    }

    // cc length check uses the same limit as to — prevents oversized CC lists
    if (cc && cc.length > MAX_TO_LENGTH) {
      return { success: false, error: `cc must be ${MAX_TO_LENGTH} characters or fewer` };
    }

    // Parse optional cc
    const ccRecipients = cc && typeof cc === 'string' ? parseRecipients(cc) : undefined;

    // Infrastructure skills need nylasClient
    if (!ctx.nylasClient) {
      return {
        success: false,
        error: 'email-send skill requires nylasClient access. Is infrastructure: true set in the manifest and nylasClient passed to ExecutionLayer?',
      };
    }

    ctx.log.info(
      { to: toRecipients.map((r) => r.email), subject },
      'Sending email',
    );

    try {
      const sent = await ctx.nylasClient.sendMessage({
        to: toRecipients,
        cc: ccRecipients,
        subject,
        body,
      });

      ctx.log.info(
        { messageId: sent.id, to: toRecipients.map((r) => r.email) },
        'Email sent successfully',
      );

      return {
        success: true,
        data: {
          message_id: sent.id,
          to: toRecipients.map((r) => r.email).join(', '),
          subject,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, to, subject }, 'Failed to send email');
      return { success: false, error: `Failed to send email: ${message}` };
    }
  }
}
