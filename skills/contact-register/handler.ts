// handler.ts — contact-register skill implementation.
//
// Bridges agents that read channels directly (e.g. the ceo-inbox agent reading
// Nylas without going through the dispatcher) into the contact system.
//
// The normal dispatcher pipeline resolves contacts, emits contact.resolved events,
// and triggers confidence scoring automatically. Agents that bypass the dispatcher
// get none of that — this skill provides the equivalent integration point.
//
// Per invocation:
//   1. Resolve by channel identity (or create a provisional contact if unknown)
//   2. Trigger a scoring delta via the confidence pipeline (or update last_seen_at
//      directly when the pipeline is not wired)
//   2b. Auto-promote provisional contacts when any engagement signal fires:
//       - curia_outbound: contact has outbound_message_count > 0 in the DB
//       - ceo_has_sent: calling agent asserts the CEO sent email to this address
//       - calendar_accepted: calling agent asserts the CEO attended an event with them
//   3. Emit a contact.resolved bus event for the audit trail
//   4. Return the contact record for use in triage / classification
//
// Promotion rules:
//   - Blocked contacts are never promoted regardless of signals.
//   - Already-confirmed contacts are a no-op (signals are not evaluated).
//   - Only provisional contacts are checked and eligible for promotion.
//
// Services used:
//   - contactService (universal — always available)
//   - confidencePipeline (capability: "confidencePipeline" — optional)
//   - bus (capability: "bus" — optional; audit trail only, skill succeeds without it)

import { randomUUID } from 'node:crypto';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createContactResolved } from '../../src/bus/events.js';

export class ContactRegisterHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const {
      channel,
      identifier,
      displayName,
      direction,
      messageTimestamp,
      ceo_has_sent,
      calendar_accepted,
    } = ctx.input as {
      channel?: string;
      identifier?: string;
      displayName?: string;
      direction?: string;
      messageTimestamp?: string;
      ceo_has_sent?: boolean;
      calendar_accepted?: boolean;
    };

    // -- Input validation --

    if (!channel || typeof channel !== 'string') {
      return { success: false, error: 'Missing required input: channel' };
    }
    if (!identifier || typeof identifier !== 'string') {
      return { success: false, error: 'Missing required input: identifier' };
    }
    if (!displayName || typeof displayName !== 'string') {
      return { success: false, error: 'Missing required input: displayName' };
    }
    if (!messageTimestamp || typeof messageTimestamp !== 'string') {
      return { success: false, error: 'Missing required input: messageTimestamp' };
    }

    const parsedTimestamp = new Date(messageTimestamp);
    if (isNaN(parsedTimestamp.getTime())) {
      return { success: false, error: `Invalid messageTimestamp — must be a valid ISO 8601 date: ${messageTimestamp}` };
    }

    // Generous upper bounds — prevent oversized payloads from reaching the DB
    if (channel.length > 50) {
      return { success: false, error: 'channel must be 50 characters or fewer' };
    }
    if (identifier.length > 500) {
      return { success: false, error: 'identifier must be 500 characters or fewer' };
    }
    if (displayName.length > 500) {
      return { success: false, error: 'displayName must be 500 characters or fewer' };
    }

    const resolvedDirection = direction ?? 'inbound';
    if (resolvedDirection !== 'inbound' && resolvedDirection !== 'outbound') {
      return { success: false, error: `direction must be 'inbound' or 'outbound', got: ${resolvedDirection}` };
    }

    if (!ctx.contactService) {
      // contactService is a universal service — this path indicates a misconfigured
      // ExecutionLayer and should never happen in normal operation.
      return {
        success: false,
        error: 'contact-register: contactService not available — check ExecutionLayer configuration',
      };
    }

    // Redact the identifier from logs to avoid leaking PII (email addresses) into
    // structured log output, which may be shipped to third-party log aggregators.
    ctx.log.info(
      { channel, direction: resolvedDirection, hasConfidencePipeline: !!ctx.confidencePipeline },
      'contact-register: registering interaction',
    );

    try {
      // -- Step 1: Resolve or create the contact --

      let resolvedSender = await ctx.contactService.resolveByChannelIdentity(channel, identifier);
      let created = false;

      if (!resolvedSender) {
        ctx.log.info({ channel }, 'contact-register: no existing contact — creating provisional');

        const contact = await ctx.contactService.createContact({
          displayName,
          // Use the identifier (e.g. email address) as a fallback display name in
          // case the displayName sanitizes to empty (prompt injection defense).
          fallbackDisplayName: identifier,
          status: 'provisional',
          source: 'agent_called',
          // Pass primaryEmail/primaryPhone so createContact() can route business
          // senders to an org KG node rather than minting a person node (issue #946).
          // Guard on '@' so a malformed identifier doesn't get passed as a primary email.
          ...(channel === 'email' && identifier.includes('@') ? { primaryEmail: identifier } : {}),
          ...(channel === 'phone' ? { primaryPhone: identifier } : {}),
        });

        // Link the identity, guarding against a concurrent call that may have created
        // and linked the same identity between our resolveByChannelIdentity check above
        // and now. If linkIdentity hits a unique-constraint violation (23505), the
        // concurrent caller won — clean up our orphaned provisional contact, then
        // re-resolve to get theirs.
        let linked = false;
        try {
          await ctx.contactService.linkIdentity({
            contactId: contact.id,
            channel,
            channelIdentifier: identifier,
            source: 'agent_called',
          });
          linked = true;
        } catch (linkErr) {
          const pgCode = (linkErr as { code?: string }).code;
          if (pgCode !== '23505') {
            // Omit identifier from the log — it is a raw email or phone number (PII) and the
            // handler deliberately avoids logging identifiers elsewhere for the same reason.
            ctx.log.warn(
              { linkErr, orphanId: contact.id, channel },
              'contact-register: linkIdentity failed with non-constraint error — rethrowing',
            );
            throw linkErr;
          }

          ctx.log.info(
            { channel, orphanId: contact.id },
            'contact-register: concurrent link conflict — cleaning up orphan and re-resolving',
          );
          // Best-effort orphan cleanup. Failure here is non-fatal — the orphaned
          // provisional contact has no linked identity and will be unreachable via
          // normal resolution, but it will leave a dangling row. Log as warn so it
          // can be caught by a periodic cleanup sweep if needed.
          try {
            await ctx.contactService.deleteContact(contact.id);
          } catch (deleteErr) {
            ctx.log.warn(
              { deleteErr, orphanId: contact.id },
              'contact-register: could not clean up orphaned provisional contact',
            );
          }
        }

        // Re-resolve to get the full ResolvedSender shape (verified flag, contactConfidence, etc.).
        resolvedSender = await ctx.contactService.resolveByChannelIdentity(channel, identifier);
        if (!resolvedSender) {
          return { success: false, error: 'contact-register: failed to resolve contact after creation — possible DB inconsistency' };
        }

        // created = true only when we won the race and linked the identity ourselves.
        // If a concurrent call won, created = false (the contact already existed from our POV).
        created = linked;
      }

      const contactId = resolvedSender.contactId;

      // -- Step 2: Update scoring signal --

      if (ctx.confidencePipeline) {
        // The pipeline handles last_seen_at, inbound_message_count, and confidence
        // atomically. Note: lastSeenAt is set to now(), not messageTimestamp, by the
        // pipeline — for real-time triage this is close enough.
        await ctx.confidencePipeline.incrementalUpdate(contactId, { type: 'message_seen' });
      } else if (resolvedDirection === 'inbound') {
        // Pipeline not wired — update last_seen_at directly using the message timestamp.
        // Only advance forward: don't roll back if a later message is processed first.
        //
        // Note: updateScoringFields is normally called by ConfidencePipeline only,
        // but we use it here as the fallback path when the pipeline is absent.
        // We pass the current contactConfidence unchanged — we're only updating the timestamp.
        const contact = await ctx.contactService.getContact(contactId);
        if (contact) {
          const shouldUpdate = !contact.lastSeenAt || parsedTimestamp > contact.lastSeenAt;
          if (shouldUpdate) {
            await ctx.contactService.updateScoringFields(contactId, {
              contactConfidence: contact.contactConfidence,
              lastSeenAt: parsedTimestamp,
            });
          }
        }
      }

      // -- Step 2b: Auto-promote provisional contacts --
      //
      // Check three engagement signals. Any single signal is sufficient to promote
      // provisional → confirmed. Blocked contacts are never promoted. Already-confirmed
      // contacts skip this block entirely (no status change, no extra DB reads).
      //
      // Signal priority (first match wins for the returned promotion_signal):
      //   1. curia_outbound — Curia has already emailed this person; DB-sourced,
      //      no caller input required.
      //   2. ceo_has_sent — caller asserts the CEO personally emailed this address.
      //   3. calendar_accepted — caller asserts the CEO attended an event with them.
      //
      // Important: resolvedSender.status is a snapshot from Step 1. Fetch the contact
      // fresh from the DB so a concurrent call that blocked/confirmed the contact between
      // Step 1 and now is respected — this prevents undoing a deliberate block.

      let promoted = false;
      let promotionSignal: string | null = null;

      if (resolvedSender.status === 'provisional') {
        // Fetch the full contact record to read outbound_message_count and get the
        // authoritative current status. This guards against TOCTOU: if a concurrent
        // call changed the status to blocked/confirmed since Step 1, we bail out.
        const contactForPromotion = await ctx.contactService.getContact(contactId);

        if (!contactForPromotion) {
          // Contact was resolved moments ago but is no longer retrievable — possible
          // concurrent deletion (e.g. admin operation). Log and skip promotion safely.
          ctx.log.warn(
            { contactId, channel },
            'contact-register: getContact returned undefined during promotion check — skipping promotion',
          );
        } else if (contactForPromotion.status !== 'provisional') {
          // Status changed since Step 1 (concurrent block or promotion). Respect
          // the current DB state and skip our own promotion attempt.
          ctx.log.info(
            { contactId, currentStatus: contactForPromotion.status },
            'contact-register: contact status changed since Step 1 — skipping promotion',
          );
        } else {
          // Contact is still provisional — evaluate signals.
          let decidedSignal: string | null = null;

          if (contactForPromotion.outboundMessageCount > 0) {
            // Curia has previously sent a message to this contact — strong signal.
            decidedSignal = 'curia_outbound';
          } else if (ceo_has_sent === true) {
            // Calling agent asserts the CEO sent from their personal inbox.
            decidedSignal = 'ceo_has_sent';
          } else if (calendar_accepted === true) {
            // Calling agent asserts the CEO has a shared accepted calendar event.
            decidedSignal = 'calendar_accepted';
          }

          if (decidedSignal) {
            // promoteToConfirmed is a conditional UPDATE (WHERE status = 'provisional').
            // If a concurrent admin block landed between our getContact check above and
            // this write, the row won't match and wasPromoted returns false — so we
            // never undo a deliberate block. promotionSignal is set only on success
            // so that promotionSignal !== null ↔ promoted === true always holds.
            const wasPromoted = await ctx.contactService.promoteToConfirmed(contactId);
            if (wasPromoted) {
              promoted = true;
              promotionSignal = decidedSignal;
              ctx.log.info(
                { contactId, promotionSignal },
                'contact-register: auto-promoted provisional contact to confirmed',
              );
            } else {
              ctx.log.info(
                { contactId },
                'contact-register: promotion aborted — contact status changed concurrently',
              );
            }
          }
        }
      }

      // -- Step 3: Emit contact.resolved bus event (audit trail) --

      if (ctx.bus) {
        const event = createContactResolved({
          contactId,
          displayName: resolvedSender.displayName,
          role: resolvedSender.role,
          kgNodeId: resolvedSender.kgNodeId,
          verificationStatus: resolvedSender.verified ? 'verified' : 'unverified',
          channel,
          channelIdentifier: identifier,
          // Use the task event ID for causal chain tracing; fall back to a fresh UUID
          // if unavailable (e.g. when called outside a standard agent.task context).
          parentEventId: ctx.taskEventId ?? randomUUID(),
          sourceLayer: 'execution',
        });
        // Fire-and-forget — a publish failure must not fail the registration itself.
        ctx.bus.publish('execution', event).catch((err: unknown) => {
          ctx.log.warn({ err, contactId }, 'contact-register: bus publish failed — audit event lost');
        });
      }

      // -- Step 4: Return updated contact record --

      // Refetch after scoring update and any promotion so status/confidence reflect
      // the latest values. Falls back to the pre-update snapshot if the fetch fails.
      // Log a warning when the refetch fails after a promotion so callers can
      // detect the stale-status edge case (promoted: true but status: 'provisional').
      const updatedContact = await ctx.contactService.getContact(contactId);
      if (!updatedContact && promoted) {
        ctx.log.warn(
          { contactId, promotionSignal, channel },
          'contact-register: getContact returned undefined after promotion — status in response reflects pre-promotion snapshot',
        );
      }

      ctx.log.info({ contactId, created, promoted, channel }, 'contact-register: interaction registered');

      return {
        success: true,
        data: {
          contact_id: contactId,
          display_name: resolvedSender.displayName,
          status: updatedContact?.status ?? resolvedSender.status,
          contact_confidence: updatedContact?.contactConfidence ?? resolvedSender.contactConfidence,
          created,
          promoted,
          ...(promotionSignal !== null ? { promotion_signal: promotionSignal } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, channel }, 'contact-register: failed to register contact interaction');
      return { success: false, error: `contact-register: ${message}` };
    }
  }
}
