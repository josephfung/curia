// Pure helpers for the Secrets page (GET /api/vault/secrets, #2453).

export interface SecretDeclarer {
  kind: 'tool' | 'mcp' | 'channel' | 'principal-mailbox' | 'email-account';
  name: string;
  required: boolean;
  enabled: boolean;
  purpose?: string;
}

export interface SecretRowData {
  name: string;
  /** Set in the vault; an environment fallback does not count. */
  configured: boolean;
  /** An enabled declarer requires it. */
  required: boolean;
  /** Environment variable supplying the value while the vault has none (name only). */
  envFallback: string | null;
  declaredBy: SecretDeclarer[];
}

const KIND_LABEL: Record<SecretDeclarer['kind'], string> = {
  tool: 'Tool',
  mcp: 'MCP server',
  channel: 'Channel',
  'principal-mailbox': '',
  'email-account': '',
};

/** "Tool web-search" / "MCP server linear (disabled)"; the mailbox kinds read as their name alone.
 *  A disabled declarer is labelled so, because it does not make the secret "missing". */
export function declarerLabel(d: SecretDeclarer): string {
  const kind = KIND_LABEL[d.kind];
  const label = kind ? `${kind} ${d.name}` : d.name;
  return d.enabled ? label : `${label} (disabled)`;
}

/** What the server reports for a 409: the confirmation dialog shows its words, so the
 *  server stays the one source of truth for what breaks and when. */
export function forceRemoveConfirmation(serverError: string): string {
  return `${serverError}\n\nRemove it anyway?`;
}
