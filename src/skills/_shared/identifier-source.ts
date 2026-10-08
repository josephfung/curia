// identifier-source.ts — whether an identifier an agent entered came from text the model
// did not write (#2061, ADR-047).
//
// contact-register (agent_called), contact-create and contact-link-identity (agent_stated)
// verify an identifier only when this says yes. The sources are the messages people sent
// in the task's conversation and the results of source tools read in it (the runtime
// builds `ctx.identifierSources`). A typo occurs in none of them, so it is never verified.

import type { ToolContext } from '../types.js';

/**
 * True when `identifier` (already normalized for `channel`) occurs in this task's
 * sources, or when the principal approved this call: the approval showed them the input.
 * A call with no sources (outside an agent task) finds nothing.
 */
export async function identifierHasSource(ctx: ToolContext, channel: string, identifier: string): Promise<boolean> {
  if (ctx.humanApproved === true) return true;
  if (!ctx.identifierSources) return false;
  return ctx.identifierSources.has(channel, identifier);
}

/**
 * Agent-facing refusal for an identifier with no source. Names the channel, never the
 * value, so the model is not handed an address to retype (ADR-047).
 */
export function unsourcedIdentifierError(channel: string, consequence: string): string {
  return `That ${channel} address appears in no message a person sent in this conversation, `
    + `and in no page, document or email read in it. ${consequence} `
    + 'Copy it exactly from where you found it, or ask the principal for it.';
}
