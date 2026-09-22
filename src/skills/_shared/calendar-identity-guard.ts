// calendar-identity-guard.ts — fail closed when a calendar read/write resolves
// to a non-principal identity while serving a principal-scoped task (#1854).
//
// The google-workspace MCP path authenticates as Curia's service account
// (`curia_google_email` / fixed_inputs.user_google_email). A successful empty
// read of that account is indistinguishable from a free day on the principal's
// calendar — the silent-lie mechanism behind the #1853 morning-brief incident.
//
// This guard is the platform backstop: even if MCP calendar tools are
// re-registered (#1330) or an agent invents a new path, principal-scoped
// reads/writes through Curia's identity return IDENTITY_MISMATCH instead of
// success + empty.

import type { ToolContext, ToolResult } from '../types.js';
import type { AgentError } from '../../errors/types.js';
import { isPrincipalOriginated, isSystemOriginated } from '../../contacts/principal.js';

/** Structured marker embedded in IDENTITY_MISMATCH error strings for audit backfill. */
export const CALENDAR_IDENTITY_MISMATCH_CODE = 'calendar_identity_mismatch' as const;

export interface CalendarIdentityMismatchDetails {
  /** Tool that attempted the read/write (e.g. get_events, calendar-list-events). */
  toolName: string;
  /** Identity the call resolved to (service account email, Nylas calendar id, etc.). */
  resolvedIdentity: string;
  /** Who the task was about (principal contact id, or 'principal' when only scoped). */
  expectedSubject: string;
  /** Calendar id argument when present (e.g. primary). */
  requestedCalendarId?: string;
  /** Source of the wrong identity (mcp_google_workspace | nylas_agent_registry). */
  source: 'mcp_google_workspace' | 'nylas_agent_registry';
}

/**
 * True when this invocation is serving principal calendar work: scheduled
 * system jobs (morning brief, etc.) or principal-originated turns.
 *
 * Agent-originated tasks are excluded so #1330 can use google-workspace for
 * Curia's own calendar without tripping this guard.
 */
export function isPrincipalScopedCalendarTask(
  taskMetadata: Record<string, unknown> | undefined,
): boolean {
  return isSystemOriginated(taskMetadata) || isPrincipalOriginated(taskMetadata);
}

/**
 * google-workspace MCP calendar tools — single source of truth for the #1853
 * holdback denylist and the #1854 identity guard. Keep in sync with the comment
 * block on the google-workspace entry in `config/skills.yaml`.
 *
 * Full upstream calendar module (`core/tool_tiers.yaml`): list_calendars, get_events,
 * manage_event (core); create_calendar, query_freebusy, manage_out_of_office,
 * manage_focus_time (extended). They authenticate as Curia's Google service identity,
 * not the principal's Nylas grant. The guard covers reads *and* writes.
 */
export const GOOGLE_WORKSPACE_CALENDAR_TOOLS = [
  'list_calendars',
  'get_events',
  'manage_event',
  'create_calendar',
  'query_freebusy',
  'manage_out_of_office',
  'manage_focus_time',
] as const;

const GOOGLE_WORKSPACE_CALENDAR_TOOL_SET: ReadonlySet<string> = new Set(
  GOOGLE_WORKSPACE_CALENDAR_TOOLS,
);

/**
 * Heuristic for calendar-shaped google-workspace tool names not yet on the denylist.
 * Underscore-segment match avoids false positives like substrings inside other words.
 */
export const GOOGLE_WORKSPACE_CALENDARISH_TOOL =
  /(^|_)(events?|calendars?|freebusy|out_of_office|focus_time)($|_)/;

/**
 * True when a google-workspace MCP tool is calendar-shaped.
 * Exact holdback list plus the calendarish heuristic — so a renamed upstream
 * tool still gets the identity guard even before the denylist is updated.
 */
export function isGoogleWorkspaceCalendarTool(toolName: string): boolean {
  if (GOOGLE_WORKSPACE_CALENDAR_TOOL_SET.has(toolName)) return true;
  return GOOGLE_WORKSPACE_CALENDARISH_TOOL.test(toolName);
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
  if (details.source === 'nylas_agent_registry') {
    parts.push(
      'This calendarId is registered to the agent\'s own contact, not the principal. ' +
        'Do not report the principal\'s day as empty. ' +
        'Pass contactId for the principal (from the system prompt) or a third-party contact, ' +
        'not an agent-owned calendarId.',
    );
  } else {
    parts.push(
      'This calendar call resolved to Curia\'s google-workspace identity, not the principal. ' +
        'Do not report the principal\'s day as empty. ' +
        'Use the @calendar specialist (Nylas calendar-list-events bound to ceo_nylas_grant_id) ' +
        'for principal calendar reads and writes.',
    );
  }
  return {
    success: false,
    errorType: 'IDENTITY_MISMATCH',
    error: parts.join(' — '),
  };
}

/**
 * Guard for google-workspace MCP calendar tools (reads and writes).
 *
 * That server always authenticates as Curia's Google identity (fixed
 * `user_google_email`). On a principal-scoped task that is definitionally the
 * wrong subject — fail before the MCP call so we never return success+empty.
 */
export function guardMcpCalendarIdentity(params: {
  serverId: string;
  toolName: string;
  ctx: ToolContext;
  /** Resolved fixed_inputs.user_google_email (Curia service account). */
  resolvedOwnerEmail?: string;
}): ToolResult | null {
  const { serverId, toolName, ctx, resolvedOwnerEmail } = params;
  if (serverId !== 'google-workspace') return null;
  if (!isGoogleWorkspaceCalendarTool(toolName)) return null;

  // Fail-open with a loud warn: without taskMetadata the guard cannot tell
  // principal-scoped from agent-scoped, and a silent pass is the #1854 failure mode.
  if (!ctx.taskMetadata) {
    ctx.log.warn(
      { tool: toolName, server: serverId, code: CALENDAR_IDENTITY_MISMATCH_CODE },
      'google-workspace calendar tool invoked with no taskMetadata — identity guard cannot assert subject (#1854)',
    );
    return null;
  }

  // Metadata present but no originator lineage — same silent fail-open as absent
  // metadata; warn so a future threading bug cannot quiet the guard again.
  if (!isPrincipalScopedCalendarTask(ctx.taskMetadata)) {
    const originator = (ctx.taskMetadata as { originator?: unknown }).originator;
    if (originator == null) {
      ctx.log.warn(
        { tool: toolName, server: serverId, code: CALENDAR_IDENTITY_MISMATCH_CODE },
        'google-workspace calendar tool invoked with taskMetadata but no originator — identity guard cannot assert subject (#1854)',
      );
    }
    return null;
  }

  const requestedCalendarId = extractRequestedCalendarId(ctx.input);
  const resolvedIdentity =
    (typeof resolvedOwnerEmail === 'string' && resolvedOwnerEmail.trim() !== ''
      ? resolvedOwnerEmail.trim()
      : null) ?? 'curia_google_email (google-workspace fixed identity)';

  ctx.log.warn(
    {
      tool: toolName,
      server: serverId,
      resolvedIdentity,
      requestedCalendarId,
      code: CALENDAR_IDENTITY_MISMATCH_CODE,
    },
    'Rejecting principal-scoped calendar call via google-workspace MCP — wrong identity (#1854)',
  );

  return calendarIdentityMismatchResult({
    toolName,
    resolvedIdentity,
    expectedSubject: 'principal',
    requestedCalendarId,
    source: 'mcp_google_workspace',
  });
}

/**
 * Guard for Nylas calendar-list-events when an explicit calendarId is supplied
 * on a principal-scoped task: fail only when the calendar is registered to the
 * *agent's own* contact (Curia's identity) — the AC for #1854.
 *
 * Third-party registered calendars (e.g. Sarah's) remain readable under the CEO
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

function extractRequestedCalendarId(input: Record<string, unknown>): string | undefined {
  for (const key of ['calendar_id', 'calendarId'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}
