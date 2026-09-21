// calendar-identity-guard.ts — fail closed when a calendar read resolves to a
// non-principal identity while serving a principal-scoped task (#1854).
//
// The google-workspace MCP path authenticates as Curia's service account
// (`curia_google_email` / fixed_inputs.user_google_email). A successful empty
// read of that account is indistinguishable from a free day on the principal's
// calendar — the silent-lie mechanism behind the #1853 morning-brief incident.
//
// This guard is the platform backstop: even if MCP calendar tools are
// re-registered (#1330) or an agent invents a new path, principal-scoped
// reads through Curia's identity return IDENTITY_MISMATCH instead of
// success + empty.

import type { ToolContext, ToolResult } from '../types.js';
import { isPrincipalOriginated, isSystemOriginated } from '../../contacts/principal.js';

/** Structured marker embedded in IDENTITY_MISMATCH error strings for audit backfill. */
export const CALENDAR_IDENTITY_MISMATCH_CODE = 'calendar_identity_mismatch' as const;

export interface CalendarIdentityMismatchDetails {
  /** Tool that attempted the read (e.g. get_events, calendar-list-events). */
  toolName: string;
  /** Identity the read resolved to (service account email, Nylas calendar id, etc.). */
  resolvedIdentity: string;
  /** Who the task was about (principal contact id, or 'principal' when only scoped). */
  expectedSubject: string;
  /** Calendar id argument when present (e.g. primary). */
  requestedCalendarId?: string;
  /** Source of the wrong identity (mcp_google_workspace | nylas_registry). */
  source: 'mcp_google_workspace' | 'nylas_registry';
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
 * not the principal's Nylas grant.
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
  parts.push(
    'This calendar read resolved to a non-principal identity. ' +
      'Do not report the principal\'s day as empty. ' +
      'Use the @calendar specialist (Nylas calendar-list-events bound to ceo_nylas_grant_id) for principal calendar reads.',
  );
  return {
    success: false,
    errorType: 'IDENTITY_MISMATCH',
    error: parts.join(' — '),
  };
}

/**
 * Guard for google-workspace MCP calendar tools.
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
  if (!isPrincipalScopedCalendarTask(ctx.taskMetadata)) return null;

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
    'Rejecting principal-scoped calendar read via google-workspace MCP — wrong identity (#1854)',
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
 * on a principal-scoped task: the registry must show that calendar belongs to
 * the principal (or be org-wide / unregistered — those stay readable under the
 * CEO grant). A calendar registered to a different contact is a mismatch.
 */
export async function guardNylasExplicitCalendarIdentity(params: {
  calendarId: string;
  ctx: ToolContext;
}): Promise<ToolResult | null> {
  const { calendarId, ctx } = params;
  if (!isPrincipalScopedCalendarTask(ctx.taskMetadata)) return null;
  if (!ctx.contactService) return null;

  const principal = await ctx.contactService.findContactBySystemRole('principal');
  if (!principal) return null;

  const resolved = await ctx.contactService.resolveCalendar(calendarId);
  // Unregistered: CEO grant may still see it (shared calendars). Org-wide
  // (contactId null): intentional. Only fail when registered to someone else.
  if (!resolved || resolved.contactId == null) return null;
  if (resolved.contactId === principal.id) return null;

  ctx.log.warn(
    {
      calendarId,
      resolvedContactId: resolved.contactId,
      principalContactId: principal.id,
      code: CALENDAR_IDENTITY_MISMATCH_CODE,
    },
    'Rejecting principal-scoped calendar read of a non-principal registered calendar (#1854)',
  );

  return calendarIdentityMismatchResult({
    toolName: 'calendar-list-events',
    resolvedIdentity: calendarId,
    expectedSubject: principal.id,
    requestedCalendarId: calendarId,
    source: 'nylas_registry',
  });
}

function extractRequestedCalendarId(input: Record<string, unknown>): string | undefined {
  for (const key of ['calendar_id', 'calendarId'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}
