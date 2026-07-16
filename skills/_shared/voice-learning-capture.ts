// voice-learning-capture.ts — best-effort OKF snapshot of Curia-authored CEO drafts (#1421).
//
// Capture failure must never block draft creation. Callers invoke this after a
// successful Nylas draft create/update and ignore the boolean result.

import type { SkillContext } from '../../src/skills/types.js';
import type { NylasParticipant } from './ceo-nylas-client.js';

export const VOICE_LEARNING_DOC_TYPE = 'voice-draft-snapshot';
export const VOICE_LEARNING_SCRATCH_PREFIX = '/scratch/voice-learning';

export interface DraftSnapshotInput {
  draftId: string;
  threadId: string;
  subject: string;
  to: NylasParticipant[];
  cc: NylasParticipant[];
  /** Plain markdown/text body Curia authored — not the HTML sent to Nylas. */
  body: string;
  agentVersion: string;
  linkedTaskIds?: string[];
}

export function draftSnapshotPath(draftId: string): string {
  return `${VOICE_LEARNING_SCRATCH_PREFIX}/${draftId}.md`;
}

/** Parse optional `linked_task_ids` from skill input. Invalid shapes → []. */
export function parseLinkedTaskIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

/**
 * Snapshot a Curia-authored draft into OKF. Returns true on success, false when
 * workingDocs is unavailable or the write failed (already logged).
 */
export async function captureDraftSnapshot(
  ctx: SkillContext,
  input: DraftSnapshotInput,
): Promise<boolean> {
  const repo = ctx.workingDocs;
  if (!repo) {
    ctx.log.warn(
      { draftId: input.draftId },
      'voice-learning-capture: workingDocs unavailable — skipping snapshot',
    );
    return false;
  }

  const path = draftSnapshotPath(input.draftId);
  const recipients = {
    to: input.to.map((p) => ({ email: p.email, ...(p.name ? { name: p.name } : {}) })),
    cc: input.cc.map((p) => ({ email: p.email, ...(p.name ? { name: p.name } : {}) })),
  };
  const frontmatter: Record<string, unknown> = {
    draft_id: input.draftId,
    thread_id: input.threadId,
    recipients,
    subject: input.subject,
    created_at: new Date().toISOString(),
    linked_task_ids: input.linkedTaskIds ?? [],
    agent_version: input.agentVersion,
  };

  try {
    const existing = await repo.read(path);
    if (!existing) {
      await repo.create({
        path,
        type: VOICE_LEARNING_DOC_TYPE,
        frontmatter,
        body: input.body,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
    } else {
      // Edit path: replace body + refresh frontmatter (keep created_at from first write).
      const mergedFrontmatter = {
        ...existing.frontmatter,
        ...frontmatter,
        created_at: existing.frontmatter.created_at ?? frontmatter.created_at,
        updated_at: new Date().toISOString(),
      };
      const result = await repo.update(path, {
        frontmatter: mergedFrontmatter,
        body: input.body,
        expectedVersion: existing.version,
        agentId: ctx.agentId ?? null,
        conversationId: ctx.conversationId ?? null,
      });
      if (!result.ok) {
        // Conflict — best-effort retry once with the conflict document's version.
        const retry = await repo.update(path, {
          frontmatter: {
            ...result.document.frontmatter,
            ...frontmatter,
            created_at: result.document.frontmatter.created_at ?? frontmatter.created_at,
            updated_at: new Date().toISOString(),
          },
          body: input.body,
          expectedVersion: result.document.version,
          agentId: ctx.agentId ?? null,
          conversationId: ctx.conversationId ?? null,
        });
        if (!retry.ok) {
          ctx.log.warn(
            { draftId: input.draftId, path },
            'voice-learning-capture: conflict on retry — leaving prior snapshot',
          );
          return false;
        }
      }
    }

    ctx.log.info(
      { draftId: input.draftId, path, threadId: input.threadId },
      'voice-learning-capture: draft snapshot written',
    );
    return true;
  } catch (err) {
    ctx.log.error(
      { err, draftId: input.draftId, path },
      'voice-learning-capture: failed to write draft snapshot — draft creation unaffected',
    );
    return false;
  }
}
