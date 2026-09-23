// handler.ts — doc-place skill (#1819).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { requireWorkingDocs } from '../../../_shared/doc-workspace.js';
import { recommendPlacement } from '../../../../src/agents/document-placement.js';
import { boundTaskFromMetadata } from '../../../../src/agents/resumable-task.js';

export class DocPlaceHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as {
      intent?: string;
      title?: string;
      proposed_slug?: string;
      leaf?: string;
      prefer_new_folder?: boolean;
    };

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;

    try {
      const timezone = ctx.timezone ?? 'UTC';
      const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());

      // Summary query — no document bodies; recent-activity window (#1819 review).
      const catalog = await ctx.workingDocs!.listProjectDirectorySummaries();

      const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
      let rootTaskId = bound?.taskId;
      let titleFromTask: string | undefined;
      if (rootTaskId && ctx.taskRepo) {
        const root = await ctx.taskRepo.resolveProjectRootTaskId(rootTaskId);
        if (root) rootTaskId = root;
        const task = await ctx.taskRepo.getTask(rootTaskId);
        titleFromTask = task?.title;
      }

      const title = typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : titleFromTask;
      const intent = typeof input.intent === 'string' ? input.intent : undefined;
      const proposed = typeof input.proposed_slug === 'string' ? input.proposed_slug : undefined;
      const leaf = typeof input.leaf === 'string' ? input.leaf : undefined;
      const preferNewFolder = input.prefer_new_folder === true;

      // Single recommendPlacement call. DB occupancy + leaf existence sit outside the
      // prompt-sized catalog so folders beyond the window still match / allocate, and
      // exact leaf hits still surface as `extend` without loading folder bodies.
      const recommendation = await recommendPlacement({
        intent,
        title,
        proposedSlug: proposed,
        leaf,
        preferNewFolder,
        catalog,
        rootTaskId,
        prefixOccupied: (slug) => ctx.workingDocs!.projectPrefixHasLiveDocs(slug),
        leafExists: (path) => ctx.workingDocs!.livePathExists(path),
      });

      return {
        success: true,
        data: {
          action: recommendation.action,
          slug: recommendation.slug,
          directory_prefix: recommendation.directoryPrefix,
          path: recommendation.path,
          reason: recommendation.reason,
          allocated: recommendation.allocated ?? false,
          collision_short_id: recommendation.collisionShortId,
          catalog: catalog.map(c => ({
            slug: c.slug,
            directory_prefix: c.directoryPrefix,
            document_count: c.documentCount,
            sample_paths: c.samplePaths,
            sample_titles: c.sampleTitles,
          })),
          displayTimezone,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'doc-place: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
