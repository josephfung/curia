import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
import type { NylasFolder } from '../_shared/ceo-nylas-client.js';

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
      ? input.add_folders
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          .map((f) => f.trim())
      : [];
    const removeFolders = Array.isArray(input.remove_folders)
      ? input.remove_folders
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          .map((f) => f.trim())
      : [];

    if (addFolders.length === 0 && removeFolders.length === 0) {
      return { success: false, error: 'at least one of add_folders or remove_folders is required' };
    }

    ctx.log.info(
      { messageId, addCount: addFolders.length, removeCount: removeFolders.length },
      'ceo-inbox-update-folders: updating message folders',
    );

    try {
      // add_folders / remove_folders arrive as display names (e.g. "⏳ In Progress")
      // or as IDs ("Label_43", "INBOX"). Gmail's PUT requires label *IDs*, so every
      // token must be resolved through the folder list (mirrors ceo-inbox-label).
      // Without this, raw display names reach Gmail and the write fails with
      // HTTP 400 "Invalid label" — and removals silently no-op because a display
      // name never matches the message's stored IDs.
      const existingFolders = await client.listFolders();
      const folderByToken = new Map<string, NylasFolder>();
      for (const f of existingFolders) {
        folderByToken.set(f.name.toUpperCase(), f);
        folderByToken.set(f.id.toUpperCase(), f);
      }
      const resolveExistingId = (token: string): string | null =>
        folderByToken.get(token.toUpperCase())?.id ?? null;

      // Resolve removals to IDs. An unknown token has nothing to remove — warn and skip.
      const removeIds = new Set<string>();
      for (const token of removeFolders) {
        const id = resolveExistingId(token);
        if (id) {
          removeIds.add(id.toUpperCase());
        } else {
          ctx.log.warn(
            { token },
            'ceo-inbox-update-folders: remove target not found among folders — skipping',
          );
        }
      }

      // Resolve additions to IDs, lazily creating the label when it does not yet
      // exist (same behaviour as ceo-inbox-label).
      const created: string[] = [];
      const addIds: string[] = [];
      for (const token of addFolders) {
        let id = resolveExistingId(token);
        if (!id) {
          ctx.log.info({ token }, 'ceo-inbox-update-folders: creating new label');
          const folder = await client.createFolder(token);
          if (!folder.id) {
            throw new Error(`Nylas returned empty folder ID for label "${token}"`);
          }
          folderByToken.set(token.toUpperCase(), folder);
          folderByToken.set(folder.id.toUpperCase(), folder);
          created.push(token);
          id = folder.id;
        }
        addIds.push(id);
      }

      // Read current folders (IDs), drop removals, append additions — all by ID.
      const msg = await client.getMessage(messageId);
      const updatedFolders = [...new Set(msg.folders ?? [])].filter(
        (f) => !removeIds.has(f.toUpperCase()),
      );
      for (const id of addIds) {
        if (!updatedFolders.some((f) => f.toUpperCase() === id.toUpperCase())) {
          updatedFolders.push(id);
        }
      }

      const result = await client.updateMessageFolders(messageId, updatedFolders);

      // Nylas sometimes omits the folders field from the PUT response (implementation-defined).
      // Fall back to the folder list we computed locally to avoid returning [] to the agent.
      // @TODO: A 200 with empty folders could also be a silent no-op write, which is
      // indistinguishable from the "field omitted from echo" case without a read-after-write.
      if (result.folders.length === 0) {
        ctx.log.warn({ messageId, nylasResult: result }, 'ceo-inbox-update-folders: Nylas returned empty folders on write — using computed folder list');
      }
      const finalFolders = result.folders.length > 0 ? result.folders : updatedFolders;

      ctx.log.info(
        { messageId, folders: finalFolders, created },
        'ceo-inbox-update-folders: updated successfully',
      );

      return {
        success: true,
        data: {
          message_id: messageId,
          folders: finalFolders,
          created,
        },
      };
    } catch (err) {
      ctx.log.error({ err, messageId }, 'ceo-inbox-update-folders: failed to update');
      return { success: false, error: 'Failed to update CEO inbox message folders' };
    }
  }
}
