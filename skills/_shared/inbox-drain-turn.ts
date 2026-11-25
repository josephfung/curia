import type { ToolContext } from '../../src/skills/types.js';
import { hasSystemLineage } from '../../src/contacts/principal.js';

/**
 * A turn of the heartbeat's inbox-drain task: system lineage (raw, or laddered down from system)
 * and a bound task tagged inbox-drain that the heartbeat created (SEC-L1: the scheduler stamps
 * createdBy on boundTask, and the dispatcher strips a forged one). A drain some other turn made
 * with task-create is invisible to the heartbeat (R56), so it gets no triage mode.
 */
export function isInboxDrainTurn(ctx: ToolContext): boolean {
  if (!hasSystemLineage(ctx.taskMetadata)) return false;
  const bound = ctx.taskMetadata?.['boundTask'];
  if (!bound || typeof bound !== 'object') return false;
  const { tags, createdBy } = bound as { tags?: unknown; createdBy?: unknown };
  return Array.isArray(tags) && tags.includes('inbox-drain') && createdBy === 'heartbeat';
}
