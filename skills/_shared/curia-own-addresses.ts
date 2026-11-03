// Curia's own mailbox addresses, for the principal-inbox tools that skip Curia's own mail
// (#2409). Messages from these addresses are Curia's outbound email, not something for the
// principal's triage.
//
// Two sources, unioned: `ctx.selfEmails` (the accounts the email channel booted with) and
// `ctx.curiaEmailAddresses()` (the email accounts table, read now). The live read covers a
// mailbox added in the console since boot; the boot list covers a failed read. A tool that
// calls this declares optional capability `curiaEmailAddresses`.

import type { ToolContext } from '../../src/skills/types.js';

// The live read is a DB query with no timeout of its own. Callers run under a ~20 s tool
// deadline, so a stalled read must give way to the boot list instead of using it all up.
export const LIVE_LOOKUP_TIMEOUT_MS = 3000;

/** Lowercased. Never throws: a failed or slow live read logs and falls back to the boot list. */
export async function curiaOwnAddresses(
  ctx: ToolContext,
  toolName: string,
  timeoutMs = LIVE_LOOKUP_TIMEOUT_MS,
): Promise<Set<string>> {
  const addresses = new Set((ctx.selfEmails ?? []).map((e) => e.toLowerCase()));
  if (ctx.curiaEmailAddresses) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const live = await Promise.race([ctx.curiaEmailAddresses(), timeout]);
      for (const email of live) addresses.add(email.toLowerCase());
    } catch (err) {
      ctx.log.warn({ err }, `${toolName}: email accounts lookup failed — using the addresses from startup`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (addresses.size === 0) {
    ctx.log.warn({}, `${toolName}: no email accounts configured — skipping Curia email filter`);
  }
  return addresses;
}
