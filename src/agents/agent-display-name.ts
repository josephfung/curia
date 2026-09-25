// Principal-facing labels for agents (#1860).
//
// Registry ids (`social-media`) are internal handles. A message the principal
// reads uses `display_name` from the agent YAML, or a phrase derived from the
// id, so the handle itself never has to stand in as a name.

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
 * Same shapes as {@link redactRawAgentId}. Hyphenated and underscored ids
 * are never natural language, so any occurrence counts. A single-word id
 * (`calendar`) counts only as a quoted handle or an `@` mention — a bare
 * "calendar" in a request is the English word, and a draft that quotes that
 * request must still be acceptable.
 */
export function containsRawAgentId(text: string, agentId: string): boolean {
  const id = agentId.trim();
  if (id.length === 0) return false;
  if (id.includes('-') || id.includes('_')) {
    return text.toLowerCase().includes(id.toLowerCase());
  }
  return singleWordHandlePattern(id).test(text);
}

/**
 * Replace registry-id occurrences with the principal-facing label.
 *
 * Hyphenated and underscored ids are not English, so any occurrence is
 * replaced. A single-word id is also a common noun (`calendar`, `contacts`),
 * so only the harness shapes are replaced: a quoted id (`'calendar'`,
 * `"calendar"`, `` `calendar` ``) and an `@calendar` mention. Bare prose
 * stays as the specialist wrote it. A function replacer keeps `$` in the
 * label from being read as a substitution.
 */
export function redactRawAgentId(text: string, agentId: string, displayName: string): string {
  const id = agentId.trim();
  if (id.length === 0 || id.toLowerCase() === displayName.toLowerCase()) return text;
  if (id.includes('-') || id.includes('_')) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(escaped, 'gi'), () => displayName);
  }
  return text.replace(singleWordHandlePattern(id), (match) => {
    if (match.startsWith('@')) return displayName;
    return `${match[0]}${displayName}${match[match.length - 1]}`;
  });
}

/** Quoted `'id'` / `"id"` / `` `id` ``, or an `@id` mention that is not already "@id specialist". */
function singleWordHandlePattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:(['"\`])${escaped}\\1|@${escaped}\\b(?!\\s+specialist\\b))`, 'gi');
}
