// Curia's own mailbox addresses, for the principal-inbox tools that skip Curia's own mail
// (#2409). Messages from these addresses are Curia's outbound email, not something for the
// principal's triage.
//
// Two sources, unioned: `ctx.selfEmails` (the accounts the email channel booted with) and
// `ctx.curiaEmailAddresses()` (the email accounts table, read now). The live read covers a
// mailbox added in the console since boot; the boot list covers a failed read. A tool that
// calls this declares optional capability `curiaEmailAddresses`.

import type { ToolContext } from '../../src/skills/types.js';

/** Lowercased. Never throws: a failed live read logs and falls back to the boot list. */
export async function curiaOwnAddresses(ctx: ToolContext, toolName: string): Promise<Set<string>> {
  const addresses = new Set((ctx.selfEmails ?? []).map((e) => e.toLowerCase()));
  if (ctx.curiaEmailAddresses) {
    try {
      for (const email of await ctx.curiaEmailAddresses()) addresses.add(email.toLowerCase());
    } catch (err) {
      ctx.log.warn({ err }, `${toolName}: email accounts lookup failed — using the addresses from startup`);
    }
  }
  if (addresses.size === 0) {
    ctx.log.warn({}, `${toolName}: no email accounts configured — skipping Curia email filter`);
  }
  return addresses;
}
