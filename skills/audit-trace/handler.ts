// skills/audit-trace/handler.ts
//
// Read-only causal-chain reconstruction for the diagnostics agent (#1356).
// From an anchor event (by id, or resolved from a block_id), walks parent_event_id
// UP to the root and children DOWN to consequences, returning the ordered,
// PII-scrubbed chain. All traversal is bounded (depth, fan-out, total nodes) and
// cycle-safe.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { AuditLogRow, AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { toEventRecord } from '../../src/diagnostics/event-record.js';
import { formatDisplayTimezone } from '../../src/time/timestamp.js';

const DEFAULT_MAX_DEPTH = 20;
const MAX_MAX_DEPTH = 100;
const DEFAULT_MAX_CHILDREN = 50;
const MAX_MAX_CHILDREN = 200;
/** Absolute cap on collected nodes, independent of depth/fan-out, as a backstop. */
const MAX_TOTAL_NODES = 500;

interface AuditTraceInput {
  event_id?: string;
  block_id?: string;
  max_depth?: number;
  max_children?: number;
}

function clamp(value: number | undefined, def: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return def;
  return Math.min(Math.floor(value), max);
}

export class AuditTraceHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const repo = ctx.auditLogRepo;
    if (!repo) {
      return { success: false, error: 'audit-trace requires auditLogRepo capability' };
    }

    const input = ctx.input as AuditTraceInput;
    const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : undefined;
    const blockId = typeof input.block_id === 'string' ? input.block_id.trim() : undefined;
    if (!eventId && !blockId) {
      return { success: false, error: 'audit-trace needs an event_id or a block_id to anchor on' };
    }

    const maxDepth = clamp(input.max_depth, DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH);
    const maxChildren = clamp(input.max_children, DEFAULT_MAX_CHILDREN, MAX_MAX_CHILDREN);
    const tz = ctx.timezone;
    const displayTimezone = tz ? formatDisplayTimezone(tz, new Date()) : undefined;

    try {
      const anchor = await this.resolveAnchor(repo, eventId, blockId);
      if (!anchor) {
        return {
          success: true,
          data: {
            anchor_event_id: eventId ?? blockId ?? '',
            chain: [],
            count: 0,
            truncated: false,
            available: false,
            displayTimezone,
          },
        };
      }

      const collected = new Map<string, AuditLogRow>([[anchor.id, anchor]]);
      let truncated = false;

      // Walk UP: follow parent_event_id to the root, cycle-safe and depth-bounded.
      let current: AuditLogRow = anchor;
      for (let depth = 0; depth < maxDepth; depth++) {
        const parentId: string | null = current.parentEventId;
        if (!parentId || collected.has(parentId)) break;
        const parent: AuditLogRow | null = await repo.findById(parentId);
        if (!parent) break;
        collected.set(parent.id, parent);
        current = parent;
        if (collected.size >= MAX_TOTAL_NODES) { truncated = true; break; }
      }
      if (current.parentEventId && !collected.has(current.parentEventId)) {
        // Stopped because we hit maxDepth (parent exists but wasn't followed).
        truncated = true;
      }

      // Walk DOWN: BFS over children, bounded by depth, per-node fan-out, and total nodes.
      let frontier = [anchor.id];
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const nodeId of frontier) {
          if (collected.size >= MAX_TOTAL_NODES) { truncated = true; break; }
          const children = await repo.findChildren(nodeId, { limit: maxChildren });
          if (children.length >= maxChildren) truncated = true;
          for (const child of children) {
            if (collected.has(child.id)) continue;
            collected.set(child.id, child);
            next.push(child.id);
            if (collected.size >= MAX_TOTAL_NODES) { truncated = true; break; }
          }
        }
        frontier = next;
      }
      if (frontier.length > 0) truncated = true; // more levels remained below maxDepth

      const chain = [...collected.values()]
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id))
        .map((row) => toEventRecord(row, tz));

      return {
        success: true,
        data: {
          anchor_event_id: anchor.id,
          chain,
          count: chain.length,
          truncated,
          available: true,
          displayTimezone,
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'audit-trace: failed to reconstruct causal chain');
      return { success: false, error: 'Unable to reconstruct the event chain right now.' };
    }
  }

  /** Resolve the anchor row from an event id, or the most relevant event for a block id. */
  private async resolveAnchor(
    repo: AuditLogRepo,
    eventId: string | undefined,
    blockId: string | undefined,
  ): Promise<AuditLogRow | null> {
    if (eventId) return repo.findById(eventId);
    if (blockId) {
      const rows = await repo.findByBlockId(blockId, { limit: 50 });
      if (rows.length === 0) return null;
      // Prefer the outbound.blocked event itself (the origin of the block) as the anchor.
      return rows.find((r) => r.eventType === 'outbound.blocked') ?? rows[0]!;
    }
    return null;
  }
}
