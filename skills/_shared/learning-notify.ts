// learning-notify.ts — event-driven surfacing of learning-digest items (#1466).
//
// After #1464 removed the scheduled daily digest, the learning-item generators (voice-learn and
// task-completion-from-sent) wrote proposals/undo-confirm items to the config store with no reader
// left to surface them. Rather than re-add a scheduled recap, each generator calls
// notifyLearningProposal the moment it produces a reviewable item — so the CEO reviews it fresh,
// in context, and only when there's something to review. The CEO's approve/dismiss/undo/confirm
// reply still resolves via resolve-learning-digest; this only adds the outbound surface.
//
// Everything here is best-effort and non-fatal: it runs AFTER the durable proposal/digest write,
// so a missing gateway, missing principal email, or a failed send must never fail the generator's
// run (which would falsely signal failure and churn the scheduler). All such cases log and return.

import type { ToolContext } from '../../src/skills/types.js';

/**
 * Resolve the principal's verified + ACTIVE email address, or null (a silent skip).
 *
 * Mirrors approval-expiry-sweep's resolvePrincipalEmail: findContactBySystemRole('principal') is
 * the single source of truth for principal identity, and delivery is restricted to a verified +
 * active email (a defunct/bounced address may be reassigned, so we don't route CEO notifications
 * to it). Never throws — a contacts-layer error on this notification path is treated as "no email".
 */
export async function resolvePrincipalEmail(ctx: ToolContext): Promise<string | null> {
  if (!ctx.contactService) {
    // Capability-wiring problem (contactService is universal, so this is unexpected) rather than a
    // benign first-run data state — log the cause; the caller logs the consequence (skip).
    ctx.log.warn('learning-notify: contactService unavailable — cannot resolve principal email');
    return null;
  }
  try {
    const principal = await ctx.contactService.findContactBySystemRole('principal');
    if (!principal) return null;
    const withIdentities = await ctx.contactService.getContactWithIdentities(principal.id);
    const identities = withIdentities?.identities ?? [];
    const email = identities.find(
      (id) => id.channel === 'email' && id.verified && id.status === 'active',
    );
    return email?.channelIdentifier ?? null;
  } catch (err) {
    ctx.log.warn({ err }, 'learning-notify: failed to resolve principal email — skipping notification');
    return null;
  }
}

/**
 * Fire a `learning_proposal` CEO notification with a pre-built subject + body.
 *
 * Best-effort and non-fatal: a missing outboundGateway, an unresolvable principal email, or a
 * false send result is logged and swallowed so the generator's primary work (the durable
 * proposal/digest write, already committed) never fails over a notification. Returns true only
 * when sendNotification confirmed the notification event was published.
 */
export async function notifyLearningProposal(
  ctx: ToolContext,
  notification: { subject: string; body: string },
): Promise<boolean> {
  // Self-contained never-throw guarantee. The generators await this bare inside their outer
  // try/catch (which converts any throw to success:false and would churn the scheduler), so the
  // "notification never fails the run" contract must not depend on sendNotification / the contacts
  // layer never throwing. Wrap the whole body so a future change to any of them stays non-fatal.
  try {
    if (!ctx.outboundGateway) {
      ctx.log.warn('learning-notify: outboundGateway unavailable — skipping learning-proposal notification');
      return false;
    }
    const ceoEmail = await resolvePrincipalEmail(ctx);
    if (!ceoEmail) {
      ctx.log.warn('learning-notify: no principal email on file — skipping learning-proposal notification');
      return false;
    }
    const sent = await ctx.outboundGateway.sendNotification({
      notificationType: 'learning_proposal',
      ceoEmail,
      subject: notification.subject,
      body: notification.body,
    });
    if (!sent) {
      ctx.log.warn('learning-notify: sendNotification returned false — CEO notification not delivered this run');
    }
    return sent;
  } catch (err) {
    ctx.log.warn({ err }, 'learning-notify: unexpected error sending learning-proposal notification — treated as non-fatal');
    return false;
  }
}
