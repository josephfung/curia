// handler.ts — held-messages-process skill implementation.
//
// Processes a held message from an unknown sender based on CEO direction:
// - "identify" — create or link a contact for the sender, then replay the
//   message through normal inbound processing so it gets routed properly.
// - "dismiss" — discard the held message (CEO doesn't care about it).
// - "block" — create a blocked contact for the sender and discard the message.
//
// This skill requires heldMessages and bus (declared in capabilities).
// contactService is a universal service and is always injected by ExecutionLayer.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createInboundMessage } from '../../src/bus/events.js';

export class HeldMessagesProcessHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { held_message_id, action, contact_name, contact_role, existing_contact_id } = ctx.input as {
      held_message_id?: string;
      action?: string;
      contact_name?: string;
      contact_role?: string;
      existing_contact_id?: string;
    };

    if (!held_message_id || typeof held_message_id !== 'string') {
      return { success: false, error: 'Missing required input: held_message_id (string)' };
    }
    if (!action || !['identify', 'dismiss', 'block'].includes(action)) {
      return { success: false, error: 'Invalid action — must be "identify", "dismiss", or "block"' };
    }
    if (!ctx.heldMessages || !ctx.bus) {
      return { success: false, error: 'Required services not available. Declare "heldMessages" and "bus" in capabilities.' };
    }

    // Validate input lengths to prevent abuse / storage overflow
    if (contact_name && contact_name.length > 200) {
      return { success: false, error: 'contact_name must be 200 characters or fewer' };
    }
    if (contact_role && contact_role.length > 100) {
      return { success: false, error: 'contact_role must be 100 characters or fewer' };
    }
    if (existing_contact_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing_contact_id)) {
      return { success: false, error: 'existing_contact_id must be a valid UUID' };
    }

    try {
      const heldMsg = await ctx.heldMessages.getById(held_message_id);
      if (!heldMsg) {
        return { success: false, error: `Held message not found: ${held_message_id}` };
      }
      if (heldMsg.status !== 'pending') {
        return { success: false, error: `Message already ${heldMsg.status}` };
      }

      if (action === 'dismiss') {
        await ctx.heldMessages.discard(held_message_id);
        ctx.log.info({ heldMessageId: held_message_id }, 'Held message dismissed');
        return { success: true, data: { result: 'dismissed' } };
      }

      if (action === 'block') {
        // Create a blocked contact for this sender
        const contact = await ctx.contactService.createContact({
          displayName: contact_name || heldMsg.senderId,
          status: 'blocked',
          source: 'ceo_stated',
        });
        // Wrap linkIdentity with the same duplicate-key guard used in the "identify"
        // path: if a prior partial run already linked this identity (linkIdentity
        // succeeded but discard failed), a retry will hit the 23505 unique constraint.
        // Treat it as a no-op when the identity is already on a blocked contact —
        // the CEO's intent is already satisfied — and proceed to discard.
        let resolvedContactId = contact.id;
        try {
          await ctx.contactService.linkIdentity({
            contactId: contact.id,
            channel: heldMsg.channel,
            channelIdentifier: heldMsg.senderId,
            source: 'ceo_stated',
          });
        } catch (linkErr) {
          const isDuplicate = (linkErr as { code?: string }).code === '23505';
          if (!isDuplicate) throw linkErr;

          // Identity already linked — check who owns it.
          // If resolveByChannelIdentity itself throws, the error propagates to the
          // outer catch. Log the orphan contact ID here so it's traceable.
          let resolved: Awaited<ReturnType<typeof ctx.contactService.resolveByChannelIdentity>>;
          try {
            resolved = await ctx.contactService.resolveByChannelIdentity(
              heldMsg.channel,
              heldMsg.senderId,
            );
          } catch (resolveErr) {
            ctx.log.error(
              { err: resolveErr, channel: heldMsg.channel, senderId: heldMsg.senderId, orphanContactId: contact.id },
              'resolveByChannelIdentity failed after 23505 (block path) — contact was created but identity not linked',
            );
            throw resolveErr;
          }
          if (!resolved) {
            ctx.log.error(
              { channel: heldMsg.channel, senderId: heldMsg.senderId, orphanContactId: contact.id },
              'Duplicate-key on linkIdentity (block) but resolveByChannelIdentity returned null — possible orphaned identity',
            );
            return {
              success: false,
              error: `Internal error: ${heldMsg.senderId} caused a duplicate-key error but no owning contact was found.`,
            };
          }
          if (resolved.status !== 'blocked') {
            ctx.log.warn(
              { channel: heldMsg.channel, senderId: heldMsg.senderId, owningContactId: resolved.contactId, owningStatus: resolved.status, orphanContactId: contact.id },
              'Cannot block sender — identity already linked to a non-blocked contact',
            );
            return {
              success: false,
              error:
                `Cannot block ${heldMsg.senderId} — that identity is already linked to contact ${resolved.contactId} (status: ${resolved.status}). Update the contact status or use contact-merge first.`,
            };
          }
          // Already linked to a blocked contact — idempotent, proceed to discard.
          resolvedContactId = resolved.contactId;
          ctx.log.info(
            { channel: heldMsg.channel, senderId: heldMsg.senderId, contactId: resolved.contactId },
            'Channel identity already linked to a blocked contact — skipping linkIdentity',
          );
        }
        await ctx.heldMessages.discard(held_message_id);
        ctx.log.info({ heldMessageId: held_message_id, contactId: resolvedContactId }, 'Sender blocked');
        return { success: true, data: { result: 'blocked', contact_id: resolvedContactId } };
      }

      // action === 'identify'
      let contactId: string;

      if (existing_contact_id) {
        // Link the sender's channel identity to the specified existing contact.
        // If the identity is already linked (e.g. contact-merge ran before us), treat
        // it as a no-op when it's linked to the right contact — otherwise surface the
        // conflict so the caller can resolve it with contact-merge first.
        contactId = existing_contact_id;
        try {
          await ctx.contactService.linkIdentity({
            contactId,
            channel: heldMsg.channel,
            channelIdentifier: heldMsg.senderId,
            source: 'ceo_stated',
          });
        } catch (linkErr) {
          // Check by PG error code (23505) — both the Postgres and in-memory backends
          // emit this code on unique constraint violations, so it's reliable across envs.
          const isDuplicate = (linkErr as { code?: string }).code === '23505';
          if (!isDuplicate) throw linkErr;

          // Identity already exists — check who owns it.
          const resolved = await ctx.contactService.resolveByChannelIdentity(
            heldMsg.channel,
            heldMsg.senderId,
          );
          if (!resolved) {
            // Unique constraint fired but lookup found nothing — data integrity anomaly.
            ctx.log.error(
              { contactId, channel: heldMsg.channel, senderId: heldMsg.senderId },
              'Duplicate-key on linkIdentity but resolveByChannelIdentity returned null — possible orphaned identity',
            );
            return {
              success: false,
              error: `Internal error: ${heldMsg.senderId} caused a duplicate-key error but no owning contact was found.`,
            };
          }
          if (resolved.contactId !== contactId) {
            // Belongs to a different contact — this is a real conflict.
            return {
              success: false,
              error:
                `Cannot link ${heldMsg.senderId} to contact ${contactId} — that identity is already linked to a different contact. Use contact-merge first.`,
            };
          }
          // Already linked to the correct contact (e.g. from contact-merge).
          // Nothing to do — fall through to markProcessed.
          ctx.log.info(
            { contactId, channel: heldMsg.channel, senderId: heldMsg.senderId },
            'Channel identity already linked to target contact — skipping linkIdentity',
          );
        }
      } else {
        // Create new confirmed contact
        if (!contact_name || typeof contact_name !== 'string') {
          return { success: false, error: 'contact_name is required when identifying a new sender' };
        }
        const contact = await ctx.contactService.createContact({
          displayName: contact_name,
          role: contact_role,
          status: 'confirmed',
          source: 'ceo_stated',
        });
        // Wrap linkIdentity with the same duplicate-key guard used by the block
        // action and the existing_contact_id path: a prior partial run may have
        // created the identity already (linkIdentity succeeded but markProcessed
        // failed), leaving us in a retry with the identity already linked.
        try {
          await ctx.contactService.linkIdentity({
            contactId: contact.id,
            channel: heldMsg.channel,
            channelIdentifier: heldMsg.senderId,
            source: 'ceo_stated',
          });
          contactId = contact.id;
        } catch (linkErr) {
          const isDuplicate = (linkErr as { code?: string }).code === '23505';
          if (!isDuplicate) {
            // Any linkIdentity failure (timeout, constraint other than 23505, etc.)
            // leaves the just-created contact as an orphan. Best-effort cleanup so
            // retries don't stack orphan rows.
            try {
              await ctx.contactService.deleteContact(contact.id);
            } catch (cleanupErr) {
              ctx.log.warn(
                { err: cleanupErr, orphanContactId: contact.id },
                'held-messages-process: failed to clean up orphan contact after non-duplicate linkIdentity failure',
              );
            }
            throw linkErr;
          }

          // Identity already linked — find the owning contact and use it.
          // The contact we just created is an orphan; clean it up.
          let resolved: Awaited<ReturnType<typeof ctx.contactService.resolveByChannelIdentity>>;
          try {
            resolved = await ctx.contactService.resolveByChannelIdentity(
              heldMsg.channel,
              heldMsg.senderId,
            );
          } catch (resolveErr) {
            // Best-effort orphan cleanup before surfacing — each stuck retry would
            // otherwise create a new orphaned contact row.
            try {
              await ctx.contactService.deleteContact(contact.id);
            } catch (cleanupErr) {
              ctx.log.warn(
                { err: cleanupErr, orphanContactId: contact.id },
                'held-messages-process: failed to clean up orphan contact before re-throwing resolveErr',
              );
            }
            ctx.log.error(
              { err: resolveErr, channel: heldMsg.channel, senderId: heldMsg.senderId, orphanContactId: contact.id },
              'resolveByChannelIdentity failed after 23505 (new-contact identify path) — orphaned contact exists',
            );
            throw resolveErr;
          }
          if (!resolved) {
            ctx.log.error(
              { channel: heldMsg.channel, senderId: heldMsg.senderId, orphanContactId: contact.id },
              'Duplicate-key on linkIdentity (new-contact identify) but resolveByChannelIdentity returned null — possible orphaned identity',
            );
            // Best-effort orphan cleanup — contact has no linked identity, so it
            // will never be found by future lookups and should not persist.
            try {
              await ctx.contactService.deleteContact(contact.id);
            } catch (cleanupErr) {
              ctx.log.warn(
                { err: cleanupErr, orphanContactId: contact.id },
                'held-messages-process: failed to clean up orphan contact (null-resolve path) — manual cleanup may be needed',
              );
            }
            return {
              success: false,
              error: `Internal error: ${heldMsg.senderId} caused a duplicate-key error but no owning contact was found.`,
            };
          }
          contactId = resolved.contactId;
          ctx.log.info(
            { channel: heldMsg.channel, senderId: heldMsg.senderId, contactId, orphanContactId: contact.id },
            'Channel identity already linked to existing contact — using it; cleaning up orphaned new contact',
          );
          // Best-effort orphan cleanup: non-fatal because the held message will
          // still be processed even if delete fails. The orphan is traceable via
          // the log above.
          try {
            await ctx.contactService.deleteContact(contact.id);
          } catch (deleteErr) {
            ctx.log.warn(
              { err: deleteErr, orphanContactId: contact.id, contactId },
              'held-messages-process: failed to delete orphaned contact — manual cleanup may be needed',
            );
          }
        }
      }

      // Set trust_level = 'high' so subsequent messages from this sender score
      // above the trust floor. contactConfidence starts at 0 for new contacts
      // (enriched later via KG), so without this override the dispatcher's
      // formula produces ~0.12 — below the default floor of 0.2 — and the next
      // email gets re-held even though the CEO explicitly confirmed the contact.
      // Mirrors the same call in outbound-gateway.enrichContactAfterSend.
      // Failure is non-fatal: the contact is identified and will be marked processed.
      try {
        await ctx.contactService.setTrustLevel(contactId, 'high');
      } catch (err) {
        ctx.log.warn(
          { err, contactId },
          'held-messages-process: setTrustLevel failed — subsequent messages from this contact may fall below trust floor',
        );
      }

      // Replay the held message through normal processing.
      // Re-publish as inbound.message so it goes through the full pipeline
      // (contact resolution -> authorization -> coordinator) with the now-known sender.
      // Published as 'channel' layer because inbound.message can only be published
      // by the channel layer (per bus permissions). A replayed message is re-entering
      // the system as if from a channel.
      const replayEvent = createInboundMessage({
        conversationId: heldMsg.conversationId,
        channelId: heldMsg.channel,
        senderId: heldMsg.senderId,
        content: heldMsg.content,
        metadata: heldMsg.metadata,
      });
      await ctx.bus.publish('channel', replayEvent);

      // Only mark as processed after successful replay — if replay fails, the
      // message stays pending so it can be retried rather than lost forever.
      await ctx.heldMessages.markProcessed(held_message_id, contactId);

      ctx.log.info(
        { heldMessageId: held_message_id, contactId, action: 'identify' },
        'Sender identified, message replayed',
      );
      return { success: true, data: { result: 'identified_and_replayed', contact_id: contactId } };
    } catch (err) {
      ctx.log.error({ err, heldMessageId: held_message_id, action }, 'held-messages-process: unexpected error');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to process held message: ${message}` };
    }
  }
}
