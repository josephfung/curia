import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

export class CeoInboxUpdateFoldersHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const messageId =
      typeof input.message_id === 'string' ? input.message_id.trim() : '';

    if (!messageId) {
      return { success: false, error: 'message_id is required' };
    }

    const addFolders = Array.isArray(input.add_folders)
      ? input.add_folders.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];
    const removeFolders = Array.isArray(input.remove_folders)
      ? input.remove_folders.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : [];

    if (addFolders.length === 0 && removeFolders.length === 0) {
      return { success: false, error: 'at least one of add_folders or remove_folders is required' };
    }

    ctx.log.info(
      { messageId, addCount: addFolders.length, removeCount: removeFolders.length },
      'ceo-inbox-update-folders: updating message folders',
    );

    try {
      // Fetch current folders, apply changes, then update
      const msg = await client.getMessage(messageId);
      const currentFolders = new Set(msg.folders ?? []);

      const removeSet = new Set(removeFolders.map((f) => f.toUpperCase()));
      const updatedFolders = [...currentFolders]
        .filter((f) => !removeSet.has(f.toUpperCase()));

      for (const folder of addFolders) {
        if (!updatedFolders.some((f) => f.toUpperCase() === folder.toUpperCase())) {
          updatedFolders.push(folder);
        }
      }

      const result = await client.updateMessageFolders(messageId, updatedFolders);

      // Nylas sometimes omits the folders field from the PUT response (implementation-defined).
      // Fall back to the folder list we computed locally to avoid returning [] to the agent.
      if (result.folders.length === 0) {
        ctx.log.warn({ messageId }, 'ceo-inbox-update-folders: Nylas returned empty folders on write — using computed folder list');
      }
      const finalFolders = result.folders.length > 0 ? result.folders : updatedFolders;

      ctx.log.info(
        { messageId, folders: finalFolders },
        'ceo-inbox-update-folders: updated successfully',
      );

      return {
        success: true,
        data: {
          message_id: messageId,
          folders: finalFolders,
        },
      };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-update-folders: failed to update');
      return { success: false, error: 'Failed to update CEO inbox message folders' };
    }
  }
}
