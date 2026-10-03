// Principal-facing labels for agents (#1860).
//
// Registry ids (`social-media`) are internal handles. A message the principal
// reads uses `display_name` from the agent YAML, or a phrase derived from the
// id, so the handle itself never has to stand in as a name.

import { escapeRegExp } from '../util/escape-regexp.js';

/**
 * Label safe to put in a principal-facing sentence.
 *
 * An explicit display name that is just the registry id is ignored — that is
 * the leak this exists to stop. An empty id becomes "specialist" (no article
 * baked in; callers write "the ${label}").
 */
export function principalAgentLabel(agentId: string, explicitDisplayName?: string): string {
  const id = agentId.trim();
  const explicit = explicitDisplayName?.trim() ?? '';
  // An explicit label that is the registry id, or that still contains a
  // harness-shaped handle, is the leak. A bare domain noun is not.
  if (
    explicit.length > 0
    && explicit.toLowerCase() !== id.toLowerCase()
    && !containsRawAgentId(explicit, id)
  ) {
    return explicit;
  }
  if (id.length === 0) return 'specialist';
  const words = id.split(/[-_]+/).filter((part) => part.length > 0).join(' ');
  if (words.length === 0) return 'specialist';
  if (/\bspecialist\b/i.test(words)) return words;
  return `${words} specialist`;
}

/**
 * True when `text` still carries the registry id as an internal handle.
 *
 * Hyphenated and underscored ids are never natural language, so any
 * occurrence counts. A single-word id (`calendar`) counts only as a quoted
 * handle (`'calendar'`, `"calendar"`, `` `calendar` ``) or an `@` mention: a
 * bare "calendar" in a reply is the English word, and a draft about the
 * principal's calendar must still be acceptable.
 *
 * There is deliberately no redact counterpart. Rewriting ids inside prose
 * written for another agent mangled tool names ("ceo inbox specialist-search")
 * and still let the rest of that prose through (#1976). Such text is not shown
 * to the principal at all.
 */
export function containsRawAgentId(text: string, agentId: string): boolean {
  const id = agentId.trim();
  if (id.length === 0) return false;
  if (id.includes('-') || id.includes('_')) {
    return text.toLowerCase().includes(id.toLowerCase());
  }
  return singleWordHandlePattern(id).test(text);
}

/** Quoted `'id'` / `"id"` / `` `id` ``, or an `@id` mention that is not already "@id specialist". */
function singleWordHandlePattern(id: string): RegExp {
  const escaped = escapeRegExp(id);
  return new RegExp(`(?:(['"\`])${escaped}\\1|@${escaped}\\b(?!\\s+specialist\\b))`, 'gi');
}
