import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { locateInMailbox, mailboxFields } from '../../../_shared/principal-mailbox-client.js';
import { describeMessage } from '../../../_shared/ceo-nylas-client.js';
import type { NylasFolder } from '../../../_shared/ceo-nylas-client.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';
import { isReadOnlySystemLabel } from '../../../../src/channels/email/system-labels.js';

export class CeoInboxLabelHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      ctx.log.warn({ inputType: typeof input.message_id }, 'ceo-inbox-label: message_id missing or not a string');
      return { success: false, error: 'message_id is required' };
    }

    const idError = validateNylasMessageId(messageId);
    if (idError) {
      return { success: false, error: idError, errorType: 'VALIDATION_ERROR' };
    }

    const labels = Array.isArray(input.labels)
      ? input.labels
          .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim())
      : [];

    if (labels.length === 0) {
      ctx.log.warn({ rawLabels: input.labels }, 'ceo-inbox-label: labels array empty or missing');
      return { success: false, error: 'labels array is required and must contain at least one label' };
    }

    // SENT and DRAFT are dropped from every write (#2426), so they are never applied.
    // Report them apart from `applied` rather than claim a label the message may lack.
    const readOnlySkipped = labels.filter(isReadOnlySystemLabel);
    const writableLabels = labels.filter((l) => !isReadOnlySystemLabel(l));
    if (writableLabels.length === 0) {
      return {
        success: false,
        error: 'SENT and DRAFT are Gmail system labels and cannot be applied; nothing was changed',
        errorType: 'VALIDATION_ERROR',
      };
    }

    // Find the message's mailbox before touching any label, so a stray label is never
    // created in the wrong account.
    const located = await locateInMailbox(ctx, input, 'ceo-inbox-label', 'message', messageId);
    if (!located.ok) return { success: false, error: located.error, ...(located.errorType ? { errorType: located.errorType } : {}) };
    const { client, mailbox } = located.at;
    const mbx = mailboxFields(mailbox);

    ctx.log.info(
      { messageId, labels: writableLabels, readOnlySkipped },
      'ceo-inbox-label: applying labels',
    );

    try {
      // Step 1: List existing folders (acts as cache for this invocation)
      const existingFolders = await client.listFolders();
      const foldersByName = new Map<string, NylasFolder>(
        existingFolders.map((f) => [f.name.toUpperCase(), f]),
      );

      // Step 2: Resolve each label to a folder ID, creating if needed
      const created: string[] = [];
      const resolvedIds: string[] = [];

      for (const label of writableLabels) {
        const key = label.toUpperCase();
        let folder = foldersByName.get(key);

        if (!folder) {
          // Label doesn't exist in Gmail — create it lazily
          ctx.log.info({ label }, 'ceo-inbox-label: creating new label');
          folder = await client.createFolder(label);
          if (!folder.id) {
            throw new Error(`Nylas returned empty folder ID for label "${label}"`);
          }
          // Add to cache so subsequent labels in this call don't re-create it
          foldersByName.set(key, folder);
          created.push(label);
        }

        resolvedIds.push(folder.id);
      }

      // Step 3: Read current message folders
      const msg = await client.getMessage(messageId);
      const currentFolders = new Set(msg.folders ?? []);

      // Step 4: Merge — add new folder IDs without removing existing ones
      for (const id of resolvedIds) {
        currentFolders.add(id);
      }

      const mergedFolders = [...currentFolders];

      // Step 5: Write back the merged folder set
      const result = await client.updateMessageFolders(messageId, mergedFolders);
      // The computed fallback still lists SENT/DRAFT even though the client dropped them from
      // the request (#2426). That is the state Gmail should end up in, since it keeps those
      // labels itself, but it is our expectation, not something Nylas confirmed.
      // Fall back to the merged set we computed if Nylas omits folders from the response
      if (result.folders.length === 0) {
        ctx.log.warn({ messageId }, 'ceo-inbox-label: Nylas returned empty folders on write — using computed merge result');
      }
      const finalFolders = result.folders.length > 0 ? result.folders : mergedFolders;

      ctx.log.info(
        { messageId, applied: writableLabels, readOnlySkipped, created, folders: finalFolders },
        'ceo-inbox-label: labels applied successfully',
      );

      return {
        success: true,
        data: {
          message_id: messageId,
          ...mbx,
          applied: writableLabels,
          read_only_skipped: readOnlySkipped,
          created,
          folders: finalFolders,
          // From the read in step 3, so no extra call. The spot-check pool shows the
          // email to the principal; "Label an email" alone cannot be graded.
          ...describeMessage(msg),
        },
      };
    } catch (err) {
      ctx.log.error({ err, messageId, labels }, 'ceo-inbox-label: failed to apply labels');
      return { success: false, ...nylasMessageFailure(err, messageId, 'Failed to apply labels to principal inbox message') };
    }
  }
}
