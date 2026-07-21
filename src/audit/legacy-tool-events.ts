// legacy-tool-events.ts — dual-match helpers for pre-ADR-031 audit rows.
//
// Phase 1 (#1485) renamed bus event types skill.* → tool.* and payload field
// skillName → toolName. Historical audit_log rows keep the old strings; readers
// that filter on the new names must expand to both so diagnostics / activity-log
// / antfarm replay do not drop pre-upgrade history.

/** New event type → pre-rename alias (and the reverse is also expanded). */
const TOOL_EVENT_ALIASES: Readonly<Record<string, string>> = {
  'tool.invoke': 'skill.invoke',
  'tool.result': 'skill.result',
  'autonomy.tool_blocked': 'autonomy.skill_blocked',
};

const LEGACY_TO_CURRENT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOOL_EVENT_ALIASES).map(([current, legacy]) => [legacy, current]),
);

/**
 * Expand a caller-supplied event-type list so a filter for `tool.*` also matches
 * stored `skill.*` rows (and vice versa). Order is stable: originals first, then
 * aliases not already present.
 */
export function expandLegacyToolEventTypes(eventTypes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of eventTypes) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    const alias = TOOL_EVENT_ALIASES[t] ?? LEGACY_TO_CURRENT[t];
    if (alias !== undefined && !seen.has(alias)) {
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
}

/** True when the type is a tool-result row under either vocabulary. */
export function isToolResultEventType(eventType: string): boolean {
  return eventType === 'tool.result' || eventType === 'skill.result';
}

/** True when the type is a tool-invoke row under either vocabulary. */
export function isToolInvokeEventType(eventType: string): boolean {
  return eventType === 'tool.invoke' || eventType === 'skill.invoke';
}

/**
 * Read the atom name from an audit payload that may use either field name.
 * Prefers the current `toolName` when both are present.
 */
export function readAuditToolName(payload: Record<string, unknown>): string | undefined {
  if (typeof payload['toolName'] === 'string') return payload['toolName'];
  if (typeof payload['skillName'] === 'string') return payload['skillName'];
  return undefined;
}
