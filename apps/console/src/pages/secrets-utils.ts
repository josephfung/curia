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
  configured: boolean;
  required: boolean;
  declaredBy: SecretDeclarer[];
}

const KIND_LABEL: Record<SecretDeclarer['kind'], string> = {
  tool: 'Tool',
  mcp: 'MCP server',
  channel: 'Channel',
  'principal-mailbox': '',
  'email-account': '',
};

/** "Tool web-search" / "MCP server linear"; the mailbox kinds read as their name alone. */
export function declarerLabel(d: SecretDeclarer): string {
  const kind = KIND_LABEL[d.kind];
  return kind ? `${kind} ${d.name}` : d.name;
}

/** Declarers whose enabled state means removing the secret breaks something. */
export function breakingDeclarers(row: SecretRowData): SecretDeclarer[] {
  return row.declaredBy.filter(d => d.required && d.enabled && d.kind !== 'principal-mailbox');
}

/** Confirmation copy for removing a secret; names what stops working, if anything. */
export function removeConfirmation(row: SecretRowData): string {
  const breaking = breakingDeclarers(row);
  if (breaking.length === 0) return `Remove ${row.name}?`;
  return `Remove ${row.name}? ${breaking.map(declarerLabel).join(', ')} will stop working until it is set again.`;
}
