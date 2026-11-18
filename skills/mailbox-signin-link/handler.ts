// handler.ts — mailbox-signin-link skill (#2361).
//
// Mints a single-use link that starts Nylas hosted sign-in for a mailbox. Like the secret-capture
// skills it returns ONLY the link: the sign-in itself happens in the principal's browser, and the
// grant it produces goes straight into the mailbox registry, never through this skill.
//
// The address the sign-in must land on is filled in by the service from the principal's verified
// identities. It is never an input, so a model cannot point a link at another account (ADR-047).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { MailboxSignInAddressError, MailboxSignInUnavailableError } from '../../src/nylas/mailbox-signin-service.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { buildCaptureOrigin } from '../../src/secrets/build-capture-origin.js';

const MAX_LABEL_LENGTH = 100;

export class MailboxSignInLinkHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.mailboxSignIn) {
      return { success: false, error: 'mailbox-signin-link requires the mailboxSignIn capability in context.' };
    }

    const { for: forInput, mailbox_label, mailbox_address } = ctx.input as {
      for?: unknown; mailbox_label?: unknown; mailbox_address?: unknown;
    };

    const target = forInput === undefined || forInput === null ? 'principal' : forInput;
    if (target !== 'principal' && target !== 'curia') {
      return { success: false, error: "for must be 'principal' or 'curia'." };
    }
    // Curia's own mailbox is set up once, by the setup wizard. Any other agent asking for it is a
    // mistake or an injection; refuse in code rather than leave it to the prompt.
    if (target === 'curia' && ctx.agentId !== 'setup-wizard') {
      return { success: false, error: "Signing in Curia's own mailbox is only available during setup." };
    }

    let label: string | undefined;
    if (mailbox_label !== undefined && mailbox_label !== null) {
      if (typeof mailbox_label !== 'string' || mailbox_label.trim().length === 0 || mailbox_label.trim().length > MAX_LABEL_LENGTH) {
        return { success: false, error: `mailbox_label must be 1 to ${MAX_LABEL_LENGTH} characters.` };
      }
      label = mailbox_label.trim();
    }

    let mailboxAddress: string | undefined;
    if (mailbox_address !== undefined && mailbox_address !== null) {
      if (typeof mailbox_address !== 'string' || mailbox_address.trim() === '') {
        return { success: false, error: 'mailbox_address must be an email address.' };
      }
      if (target === 'curia') {
        return { success: false, error: "mailbox_address applies only to the principal's own mailboxes." };
      }
      // Not trusted: the service checks it against the principal's verified addresses and refuses
      // anything else, so the model can pick among them but never invent one.
      mailboxAddress = mailbox_address.trim();
    }

    // Route the finished sign-in back to this conversation. A delegated specialist's resume is
    // retargeted at the coordinator by the shared helper (#995).
    const origin = buildCaptureOrigin(
      ctx,
      target === 'curia' ? "Sign in Curia's own mailbox" : `Sign in the principal's mailbox${label ? ` "${label}"` : ''}`,
    );

    try {
      const { url, expiresAt } = await ctx.mailboxSignIn.mint({
        target,
        ...(label !== undefined ? { label } : {}),
        ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
        origin,
      });
      const expiresLocal = toLocalIso(Math.floor(expiresAt.getTime() / 1000), ctx.timezone);
      return {
        success: true,
        data: {
          sign_in_url: url,
          expires_at: expiresLocal,
          target,
          displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone, new Date()) : undefined,
          summary:
            'Reply with the sign_in_url EXACTLY as given, including the full token: do not redact, mask, ' +
            'shorten or alter it. The link is safe to share; it is one-time, tied to this request, and expires ' +
            'at expires_at. Tell the principal that Google may show an "unverified app" screen (they can ' +
            'continue past it) and may ask for consent twice, and that both permission boxes (mail and ' +
            'calendar) must stay ticked or the connection will be refused. You will be told when the sign-in ' +
            'finishes; do not claim the mailbox is connected before then.',
        },
      };
    } catch (err) {
      if (err instanceof MailboxSignInAddressError) {
        ctx.log.warn({ reason: err.reason }, 'mailbox-signin-link: no usable principal address');
        return { success: false, error: err.message };
      }
      if (err instanceof MailboxSignInUnavailableError) {
        // The reason and its operator-facing detail carry no key or Nylas body. Surface them so the
        // agent can send the principal to the fix (usually Channels → Email in the console).
        ctx.log.warn({ reason: err.reason }, 'mailbox-signin-link: sign-in unavailable');
        return { success: false, error: err.message };
      }
      ctx.log.error({ err }, 'mailbox-signin-link failed');
      return { success: false, error: 'Could not create a sign-in link. Try again in a moment.' };
    }
  }
}
