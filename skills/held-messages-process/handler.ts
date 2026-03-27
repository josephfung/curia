// handler.ts — held-messages-process skill implementation.
//
// Processes a held message from an unknown sender based on CEO direction:
// - "identify" — create or link a contact for the sender, then replay the
//   message through normal inbound processing so it gets routed properly.
// - "dismiss" — discard the held message (CEO doesn't care about it).
// - "block" — create a blocked contact for the sender and discard the message.
//
// This is an infrastructure skill — it requires heldMessages, contactService,
// and bus access.

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
    if (!ctx.heldMessages || !ctx.contactService || !ctx.bus) {
      return { success: false, error: 'Required services not available. Is infrastructure: true set?' };
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
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
        await ctx.heldMessages.discard(held_message_id);
        ctx.log.info({ heldMessageId: held_message_id, contactId: contact.id }, 'Sender blocked');
        return { success: true, data: { result: 'blocked', contact_id: contact.id } };
      }

      // action === 'identify'
      let contactId: string;

      if (existing_contact_id) {
        // Link to existing contact
        contactId = existing_contact_id;
        await ctx.contactService.linkIdentity({
          contactId,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
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
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
        contactId = contact.id;
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
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to process held message: ${message}` };
    }
  }
}
