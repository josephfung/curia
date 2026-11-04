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
  'email-account': 'Email account',
};

/** "Tool web-search" / "MCP server linear (disabled)"; the principal mailbox reads as its name alone.
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

/** The error text of a failed response; guards against non-JSON bodies. */
export async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch { /* fall through to HTTP status */ }
  }
  return `HTTP ${res.status}`;
}

/** Remove a secret: ask first, then DELETE WITHOUT force. If an enabled component requires
 *  the key the server answers 409 with what breaks and when; that message goes in a second
 *  confirmation and only an explicit yes retries with force. The server, not the page's
 *  possibly stale list, decides whether the removal is dangerous. Throws on any other
 *  failure; resolves 'cancelled' when either confirmation is declined. */
export async function removeSecretFlow(
  name: string,
  deps: { confirm: (message: string) => boolean; del: (force: boolean) => Promise<Response> },
): Promise<'removed' | 'cancelled'> {
  if (!deps.confirm(`Remove ${name}?`)) return 'cancelled';
  let res = await deps.del(false);
  if (res.status === 409) {
    if (!deps.confirm(forceRemoveConfirmation(await errorMessage(res)))) return 'cancelled';
    res = await deps.del(true);
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return 'removed';
}
