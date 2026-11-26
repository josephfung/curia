// Write guards shared by the tools that write OKF documents: doc-write, and doc-publish-google,
// which records the published Doc in a document's frontmatter (#2758). Moved here unchanged
// from doc-write so both enforce the same rules.

import type { ToolContext } from '../../src/skills/types.js';
import type { WorkingDocRow } from '../../src/db/working-docs-repo.js';
import { isSharedDocPath } from '../../src/memory/durable-doc-prefixes.js';
import { PRINCIPAL_SEND_LEDGER_PREFIX } from '../../src/skills/principal-send/send-ledger.js';
import { EDITABLE_BY_KEY, editableBy } from '../../src/memory/console-only-docs.js';

/**
 * `/shared/` write guard (#2338): declaring a path in `pinned_context` is the
 * permission to write it. Every declaring agent may write; nobody else may, and a
 * call with no agent (or no roster to check) is refused. Two writers bypass it:
 * the console, which does not go through doc-write, and a principal-approved
 * re-execution (ADR-018), which carries no agentId and is the principal's own
 * decision. Returns an error, or null to allow.
 */
export function sharedPathWriteError(ctx: ToolContext, normalizedPath: string, tool = 'doc-write'): string | null {
  if (!isSharedDocPath(normalizedPath)) return null;
  if (ctx.humanApproved) return null;
  const declared = ctx.agentId ? ctx.agentRegistry?.get(ctx.agentId)?.pinnedDocPaths : undefined;
  if (declared?.includes(normalizedPath)) return null;
  ctx.log.warn(
    { path: normalizedPath, agentId: ctx.agentId ?? null },
    `${tool}: refused /shared/ write from an agent that does not declare the path`,
  );
  return `${normalizedPath} is a shared document, and only an agent that declares it in pinned_context can write it. Leave it unchanged; the principal can edit it in the console.`;
}

/**
 * Principal-mailbox send ledger guard (#2474 final fixes B1, security review M1). The ledger is
 * the autonomous send cooldown and daily cap: an agent that rewrote or forged an entry could
 * lift them. Only PrincipalSendLedger writes there, through WorkingDocsRepo directly, never this
 * tool. Every mode and every caller is refused, a principal-approved replay included. Compared
 * case-insensitively, after normalization (fail closed).
 * Returns an error, or null to allow.
 */
export function sendLedgerPathWriteError(ctx: ToolContext, normalizedPath: string, tool = 'doc-write'): string | null {
  const path = normalizedPath.toLowerCase();
  const prefix = PRINCIPAL_SEND_LEDGER_PREFIX.toLowerCase();
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, `${tool}: refused a write to the principal-mailbox send ledger`);
  return `${PRINCIPAL_SEND_LEDGER_PREFIX}/ holds Curia's record of sends from the principal's mailbox, which only the send path writes. Leave it unchanged.`;
}

/**
 * Console-only documents (#2360): a document whose frontmatter carries `editable_by` is edited in
 * the console (the documents API, which does not use this tool), never by an agent. `console` is
 * the only value; any other value is treated the same (fail closed). So:
 *  - every mode on such a document is refused unless the write is a principal-approved
 *    re-execution (`humanApproved`, the principal's own decision);
 *  - no write here may add, change or remove the key, whoever calls (in create or replace, the
 *    frontmatter given replaces the stored one, so leaving the key out removes it).
 * Read from the live document, so an archived one no longer guards its path.
 * Returns an error, or null to allow.
 */
export function consoleOnlyWriteError(
  ctx: ToolContext,
  normalizedPath: string,
  existing: WorkingDocRow | null,
  frontmatter: Record<string, unknown> | undefined,
  tool = 'doc-write',
): string | null {
  const stored = editableBy(existing?.frontmatter);
  if (frontmatter !== undefined && JSON.stringify(editableBy(frontmatter)) !== JSON.stringify(stored)) {
    ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, `${tool}: refused a write that sets, changes or removes ${EDITABLE_BY_KEY}`);
    return stored === undefined
      ? `doc-write cannot set ${EDITABLE_BY_KEY}: only the console marks a document console-only. Leave the key out.`
      : `${normalizedPath} is console-only (${EDITABLE_BY_KEY}), and doc-write cannot change or remove that key. Leave it unchanged.`;
  }
  if (stored === undefined || ctx.humanApproved) return null;
  ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, `${tool}: refused a write to a console-only document`);
  return `${normalizedPath} is edited only in the console (${EDITABLE_BY_KEY}: console). Leave it unchanged; the principal or operator can edit it there.`;
}
