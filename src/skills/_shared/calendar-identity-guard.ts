// calendar-identity-guard.ts — fail closed when a calendar read resolves to a
// non-principal identity while serving a principal-scoped task (#1854).
//
// A successful empty read of the wrong calendar is indistinguishable from a free
// day on the principal's — the silent-lie mechanism behind the #1853 morning-brief
// incident. The remaining path is Nylas `calendar-list-events` given an explicit
// calendarId that belongs to the agent's own contact.
//
// The google-workspace MCP calendar guard that also lived here was removed in
// #1957: Calendar is never on that server's --tools allowlist, so its tools are
// never registered. If #1330 ever adds them back on purpose, restore it from history.

import type { ToolContext, ToolResult } from '../types.js';
import type { AgentError } from '../../errors/types.js';
import { isPrincipalOriginated, isSystemOriginated } from '../../contacts/principal.js';

/** Structured marker embedded in IDENTITY_MISMATCH error strings for audit backfill. */
export const CALENDAR_IDENTITY_MISMATCH_CODE = 'calendar_identity_mismatch' as const;

export interface CalendarIdentityMismatchDetails {
  /** Tool that attempted the read (e.g. calendar-list-events). */
  toolName: string;
  /** Identity the call resolved to (the agent-owned Nylas calendar id). */
  resolvedIdentity: string;
  /** Who the task was about (principal contact id, or 'principal' when only scoped). */
  expectedSubject: string;
  /** Calendar id argument when present (e.g. primary). */
  requestedCalendarId?: string;
  /** Source of the wrong identity. Kept as a field so the error string format, which
   *  audit queries match on, is unchanged. */
  source: 'nylas_agent_registry';
}

/**
 * True when this invocation is serving principal calendar work: scheduled
 * system jobs (morning brief, etc.) or principal-originated turns.
 *
 * Agent-originated tasks are excluded: an agent reading its own calendar for its
 * own work is not a mismatch.
 */
export function isPrincipalScopedCalendarTask(
  taskMetadata: Record<string, unknown> | undefined,
): boolean {
  return isSystemOriginated(taskMetadata) || isPrincipalOriginated(taskMetadata);
}

/**
 * Build a fail-closed ToolResult for a calendar identity mismatch.
 * `errorType: IDENTITY_MISMATCH` is the queryable audit signal; the error
 * string carries a stable code + structured fields for operators and agents.
 */
export function calendarIdentityMismatchResult(
  details: CalendarIdentityMismatchDetails,
): ToolResult {
  const parts = [
    `IDENTITY_MISMATCH (${CALENDAR_IDENTITY_MISMATCH_CODE})`,
    `tool=${details.toolName}`,
    `source=${details.source}`,
    `resolvedIdentity=${details.resolvedIdentity}`,
    `expectedSubject=${details.expectedSubject}`,
  ];
  if (details.requestedCalendarId) {
    parts.push(`requestedCalendarId=${details.requestedCalendarId}`);
  }
  parts.push(
    'This calendarId is registered to the agent\'s own contact, not the principal. ' +
      'Do not report the principal\'s day as empty. ' +
      'Pass contactId for the principal (from the system prompt) or a third-party contact, ' +
      'not an agent-owned calendarId.',
  );
  return {
    success: false,
    errorType: 'IDENTITY_MISMATCH',
    error: parts.join(' — '),
  };
}

/**
 * Guard for Nylas calendar-list-events when an explicit calendarId is supplied
 * on a principal-scoped task: fail only when the calendar is registered to the
 * *agent's own* contact (Curia's identity) — the AC for #1854.
 *
 * Third-party registered calendars (e.g. Sarah's) remain readable under the principal
 * grant via explicit calendarId or contactId; rejecting those was an accidental
 * over-block. Org-wide / unregistered IDs also pass.
 */
export async function guardNylasExplicitCalendarIdentity(params: {
  calendarId: string;
  ctx: ToolContext;
}): Promise<ToolResult | null> {
  const { calendarId, ctx } = params;
  if (!isPrincipalScopedCalendarTask(ctx.taskMetadata)) return null;

  if (!ctx.contactService) {
    ctx.log.warn(
      { calendarId, code: CALENDAR_IDENTITY_MISMATCH_CODE },
      'calendar-list-events identity guard skipped — contactService unavailable (#1854)',
    );
    return null;
  }

  const principal = await ctx.contactService.findContactBySystemRole('principal');
  if (!principal) {
    ctx.log.warn(
      { calendarId, code: CALENDAR_IDENTITY_MISMATCH_CODE },
      'calendar-list-events identity guard skipped — no principal contact row (#1854)',
    );
    return null;
  }

  const agentContactId = ctx.agentContactId;
  if (!agentContactId) {
    // Without the agent's contact id we cannot detect agent-owned calendars.
    // Do not reject third-party calendars; just note we cannot run this check.
    ctx.log.warn(
      { calendarId, code: CALENDAR_IDENTITY_MISMATCH_CODE },
      'calendar-list-events identity guard skipped — agentContactId unset (#1854)',
    );
    return null;
  }

  const resolved = await ctx.contactService.resolveCalendar(calendarId);
  if (!resolved || resolved.contactId == null) return null;
  // Principal-owned and third-party calendars are allowed.
  if (resolved.contactId !== agentContactId) return null;

  ctx.log.warn(
    {
      calendarId,
      resolvedContactId: resolved.contactId,
      principalContactId: principal.id,
      agentContactId,
      code: CALENDAR_IDENTITY_MISMATCH_CODE,
    },
    'Rejecting principal-scoped calendar read of an agent-owned registered calendar (#1854)',
  );

  return calendarIdentityMismatchResult({
    toolName: 'calendar-list-events',
    resolvedIdentity: calendarId,
    expectedSubject: principal.id,
    requestedCalendarId: calendarId,
    source: 'nylas_agent_registry',
  });
}

/**
 * Detect IDENTITY_MISMATCH from a direct skill failure *or* a delegate soft-failure
 * (`{ success: true, data: { failed: true, errorType: 'IDENTITY_MISMATCH' } }`).
 * Used by the agent runtime so a coordinating scheduled job hard-fails when the
 * specialist (e.g. `@calendar`) hit the guard (#1854).
 */
export function identityMismatchFromToolResult(
  toolName: string,
  result: ToolResult,
): AgentError | null {
  if (!result.success) {
    if (result.errorType !== 'IDENTITY_MISMATCH') return null;
    return {
      type: 'IDENTITY_MISMATCH',
      source: `skill:${toolName}`,
      message: result.error,
      retryable: false,
      context: { toolName },
      timestamp: new Date(),
    };
  }

  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const payload = data as Record<string, unknown>;
  if (payload.failed !== true || payload.errorType !== 'IDENTITY_MISMATCH') return null;

  const message =
    typeof payload.message === 'string' && payload.message.trim() !== ''
      ? payload.message
      : `Delegated skill reported IDENTITY_MISMATCH via ${toolName}`;

  return {
    type: 'IDENTITY_MISMATCH',
    source: `skill:${toolName}`,
    message,
    retryable: false,
    context: {
      toolName,
      via: 'delegate',
      ...(typeof payload.agent === 'string' && { specialistAgent: payload.agent }),
    },
    timestamp: new Date(),
  };
}
