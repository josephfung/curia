// handler.ts — doc-list skill (#1209).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import {
  listDirectoryProjection,
  requireWorkingDocs,
} from '../_shared/doc-workspace.js';
import { looksLikeDocumentPath } from '../../src/agents/document-workspace.js';

export class DocListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { path } = ctx.input as { path?: string };

    if (!path || typeof path !== 'string' || !path.trim()) {
      return { success: false, error: 'Missing required input: path (directory prefix string)' };
    }
    if (looksLikeDocumentPath(path)) {
      return {
        success: false,
        error: 'path must be a directory prefix (e.g. /projects/x/), not a document file path — use doc-read for documents',
      };
    }

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;

    try {
      const timezone = ctx.timezone ?? 'UTC';
      const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());
      const { directory, index_path, manifest, documents } = await listDirectoryProjection(ctx, path);
      const directChildren = documents.filter(d => {
        const remainder = d.path.slice(directory.length);
        return remainder.length > 0 && !remainder.includes('/');
      });

      return {
        success: true,
        data: {
          directory,
          index_path,
          manifest,
          document_count: directChildren.length,
          documents: directChildren.map(d => ({
            path: d.path,
            type: d.type,
            title: typeof d.frontmatter.title === 'string' ? d.frontmatter.title : undefined,
            updated_at: toLocalIso(Math.floor(new Date(d.updatedAt).getTime() / 1000), timezone),
          })),
          updated_at: toLocalIso(Math.floor(Date.now() / 1000), timezone),
          displayTimezone,
        },
      };
    } catch (err) {
      ctx.log.error({ err, path }, 'doc-list: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
