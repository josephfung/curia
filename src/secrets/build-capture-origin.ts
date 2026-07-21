// build-capture-origin.ts — shared origin builder for the secret-capture tools (#995).
//
// Both secret-capture-request (user secrets) and system-secret-capture-request (channel/system
// credentials) need the same logic: capture the agent's routing so redeem can re-enter it, and —
// when the agent runs as a DELEGATED specialist — retarget the resume at the coordinator (a
// deliverable channel) and mint a resume_token so the coordinator can re-delegate back to the
// specialist. This helper holds NO secret material: only routing, names, and an NL intent.

import { encodeResumeToken } from '../agents/resume-token.js';
import type { CaptureOrigin } from './secret-capture-service.js';
import type { ToolContext } from '../skills/types.js';

/** Shape the delegate skill writes into task metadata (#995). All fields optional because it is
 *  decoded from opaque metadata; the retarget only fires when the routing trio is fully present. */
interface DelegationOrigin {
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  originalTask?: string;
}

/**
 * Build the CaptureOrigin to persist on a capture token.
 *
 * - Non-delegated (coordinator-minted): returns the agent's own routing so redeem re-enters it
 *   directly (#972).
 * - Delegated specialist: retargets routing at the coordinator and attaches a resume_token naming
 *   this specialist + its brief, so the redeem event re-enters the coordinator to re-delegate (#995).
 *
 * @param resumeIntent natural-language description of what to resume (the user ask, or the label).
 */
export function buildCaptureOrigin(ctx: ToolContext, resumeIntent: string): CaptureOrigin {
  const originator = ctx.taskMetadata?.originator as Record<string, unknown> | undefined;
  const delegationOrigin = ctx.taskMetadata?.delegationOrigin as DelegationOrigin | undefined;

  // Delegated specialist — only when delegate populated the full routing trio. Re-entering the
  // specialist's own 'internal' channel would reach no user, so retarget at the coordinator.
  if (
    delegationOrigin &&
    ctx.agentId &&
    delegationOrigin.conversationId &&
    delegationOrigin.channelId &&
    delegationOrigin.agentId
  ) {
    return {
      conversationId: delegationOrigin.conversationId,
      channelId: delegationOrigin.channelId,
      agentId: delegationOrigin.agentId,
      // taskEventId omitted: the coordinator's task id isn't threaded here; the resume subscriber
      // falls back to the event id for parentEventId.
      originator,
      resumeIntent,
      resumeToken: encodeResumeToken({
        agent: ctx.agentId,
        originalTask: delegationOrigin.originalTask ?? resumeIntent,
        context: resumeIntent,
      }),
    };
  }

  // Non-delegated — re-enter this agent in this conversation directly (#972).
  return {
    conversationId: ctx.conversationId,
    channelId: ctx.channelId,
    agentId: ctx.agentId,
    taskEventId: ctx.taskEventId,
    originator,
    resumeIntent,
  };
}
