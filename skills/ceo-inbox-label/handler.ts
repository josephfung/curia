import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
import type { NylasFolder } from '../_shared/ceo-nylas-client.js';

export class CeoInboxLabelHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      ctx.log.warn({ inputType: typeof input.message_id }, 'ceo-inbox-label: message_id missing or not a string');
      return { success: false, error: 'message_id is required' };
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

    ctx.log.info(
      { messageId, labels },
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

      for (const label of labels) {
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
      // Fall back to the merged set we computed if Nylas omits folders from the response
      if (result.folders.length === 0) {
        ctx.log.warn({ messageId }, 'ceo-inbox-label: Nylas returned empty folders on write — using computed merge result');
      }
      const finalFolders = result.folders.length > 0 ? result.folders : mergedFolders;

      ctx.log.info(
        { messageId, applied: labels, created, folders: finalFolders },
        'ceo-inbox-label: labels applied successfully',
      );

      return {
        success: true,
        data: {
          message_id: messageId,
          applied: labels,
          created,
          folders: finalFolders,
        },
      };
    } catch (err) {
      ctx.log.error({ err, messageId, labels }, 'ceo-inbox-label: failed to apply labels');
      const detail = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to apply labels to CEO inbox message: ${detail}` };
    }
  }
}
