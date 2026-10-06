// debrief-recap.ts — the recap steps a scheduled debrief job carries when it fires (#1959).
//
// The trigger is the job, not the prompt: the setup wizard creates the debrief as a
// coordinator job with intent anchor `daily_debrief` or `weekly_debrief`, and setup-status
// detects it by the same anchor. Matching the anchor rather than the payload text keeps a
// task that merely mentions a debrief from being turned into a recap run.

import {
  DAILY_DEBRIEF_RECAP_INSTRUCTION,
  WEEKLY_DEBRIEF_RECAP_INSTRUCTION,
} from '../agents/prompts/debrief-recap-instruction.js';

/** The recap steps for this job, or undefined when it is not a coordinator debrief job. */
export function debriefRecapInstruction(job: {
  agentId: string;
  intentAnchor: string | null;
}): string | undefined {
  if (job.agentId !== 'coordinator') return undefined;
  const anchor = job.intentAnchor?.trim().toLowerCase() ?? '';
  // Same test setup-status uses to decide the debrief is scheduled.
  if (!anchor.includes('debrief')) return undefined;
  return anchor.includes('weekly') ? WEEKLY_DEBRIEF_RECAP_INSTRUCTION : DAILY_DEBRIEF_RECAP_INSTRUCTION;
}
