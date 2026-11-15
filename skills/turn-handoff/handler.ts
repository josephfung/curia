// handler.ts — turn-handoff tool (#2588).
//
// The coordinator calls this when a person's new message corrects or adds to the work of their
// own turn still running in another conversation. The handler only validates the turn id and
// returns a marker. The runtime sees the marker, delivers the person's message into that turn
// (or holds it for the turn's wake), and replaces this result with what the model should say.
// No side effects here.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

/** A turn id is a task event id (UUID) or a voice session id; anything longer is not one. */
const TURN_ID_MAX = 200;

export class TurnHandoffHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { turn_id: raw } = ctx.input as { turn_id?: unknown };
    if (typeof raw !== 'string') {
      return { success: false, error: 'Missing required input: turn_id (string)' };
    }
    const turnId = raw.trim();
    if (turnId === '') {
      return { success: false, error: 'turn_id must not be empty' };
    }
    if (turnId.length > TURN_ID_MAX) {
      return { success: false, error: `turn_id must be at most ${TURN_ID_MAX} characters` };
    }
    ctx.log.info({ turnId }, 'turn-handoff: hand-off requested');
    return { success: true, data: { handoff_requested: true, turn_id: turnId } };
  }
}
