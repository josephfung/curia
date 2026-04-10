// handler.ts — email-send skill implementation.
//
// Sends a new email via the OutboundGateway. The gateway enforces contact
// blocked checks and content filtering before dispatch — this handler
// focuses on input validation and formatting.
//
// sensitivity: "elevated" — enforced by the gateway's security pipeline.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const MAX_TO_LENGTH = 1000;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((email) => {
      if (!EMAIL_REGEX.test(email)) {
        throw new Error(`Invalid email address: ${email}`);
      }
      return email;
    });
}

export class EmailSendHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { to, cc, subject, body } = ctx.input as {
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
    };

    if (!to || typeof to !== 'string') {
      return { success: false, error: 'Missing required input: to (string)' };
    }
    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    if (to.length > MAX_TO_LENGTH) {
      return { success: false, error: `to must be ${MAX_TO_LENGTH} characters or fewer` };
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return { success: false, error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer` };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    let toAddresses: string[];
    try {
      toAddresses = parseRecipients(to);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
    if (toAddresses.length === 0) {
      return { success: false, error: 'to field contains no valid email addresses' };
    }
    // Only a single To recipient is supported. Multiple addresses in the to field
    // would silently drop all but the first while reporting success for all of them.
    // Direct the caller to use cc for additional recipients instead.
    if (toAddresses.length > 1) {
      return { success: false, error: 'email-send supports a single To recipient. Use the cc field for additional recipients.' };
    }

    if (cc && cc.length > MAX_TO_LENGTH) {
      return { success: false, error: `cc must be ${MAX_TO_LENGTH} characters or fewer` };
    }

    let ccAddresses: string[] | undefined;
    try {
      ccAddresses = cc && typeof cc === 'string' ? parseRecipients(cc) : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-send skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    ctx.log.info({ to: toAddresses, subject }, 'Sending email via gateway');

    try {
      const result = await ctx.outboundGateway.send({
        channel: 'email',
        to: toAddresses[0]!,
        subject,
        body,
        cc: ccAddresses,
        triggerSource: ctx.triggerSource,
      });

      if (!result.success) {
        return { success: false, error: result.blockedReason ?? 'Email send failed' };
      }

      return {
        success: true,
        data: {
          message_id: result.messageId,
          to: toAddresses.join(', '),
          subject,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, to: toAddresses, subject }, 'Failed to send email');
      return { success: false, error: `Failed to send email: ${message}` };
    }
  }
}
