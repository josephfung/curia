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
  if (explicit.length > 0 && !containsRawAgentId(explicit, id)) {
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
 * occurrence counts. A single-word id (`calendar`) counts only when it is
 * not the display phrase "calendar specialist".
 */
export function containsRawAgentId(text: string, agentId: string): boolean {
  const id = agentId.trim();
  if (id.length === 0) return false;
  if (id.includes('-') || id.includes('_')) {
    return text.toLowerCase().includes(id.toLowerCase());
  }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b(?!\\s+specialist\\b)`, 'i');
  return re.test(text);
}

/** Replace registry-id occurrences with the principal-facing label. */
export function redactRawAgentId(text: string, agentId: string, displayName: string): string {
  const id = agentId.trim();
  if (id.length === 0 || id === displayName) return text;
  return text.split(id).join(displayName);
}
