// Pure helpers for the Secrets page (GET /api/vault/secrets, #2453).

export interface SecretDeclarer {
  kind: 'tool' | 'mcp' | 'channel' | 'principal-mailbox' | 'email-account' | 'platform';
  name: string;
  required: boolean;
  enabled: boolean;
  purpose?: string;
}

export type SecretKind = 'personal' | 'system' | 'platform';

/** Mirrors VaultCardSummary in src/channels/http/routes/vault.ts: a saved card's public fields. */
export interface SecretCardSummary {
  label: string | null;
  brand: 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';
  last4: string;
  /** "MM/YYYY". */
  expiry: string;
  expired: boolean;
}

/** Mirrors VaultSecretSummary in src/channels/http/routes/vault.ts (the console cannot import from src/). */
export interface SecretRowData {
  name: string;
  kind: SecretKind;
  /** Set in the vault; an environment fallback does not count. */
  configured: boolean;
  /** An enabled declarer requires it. */
  required: boolean;
  /** Environment variable supplying the value while the vault has none (name only). */
  envFallback: string | null;
  declaredBy: SecretDeclarer[];
  /** null when the secret is not in the vault. */
  valueFormat: 'string' | 'json' | null;
  /** ISO timestamps; null when not in the vault. */
  createdAt: string | null;
  updatedAt: string | null;
  /** Latest recorded read by Curia; null when never read or no usage source is wired. */
  lastUsedAt: string | null;
  /** Read once when Curia starts, so individual reads are not recorded. */
  readAtStartup: boolean;
  /** Personal rows only: non-secret sign-in details. */
  loginUrl?: string;
  username?: string;
  /** Personal rows holding a saved card only. */
  card?: SecretCardSummary;
}

const KIND_LABEL: Record<SecretDeclarer['kind'], string> = {
  tool: 'Tool',
  mcp: 'MCP server',
  channel: 'Channel',
  'principal-mailbox': '',
  'email-account': 'Email account',
  platform: '',
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

// ---------------------------------------------------------------------------
// List helpers: status, filter, sort, duplicates, labels
// ---------------------------------------------------------------------------

export type SecretStatus = 'configured' | 'expired' | 'env' | 'missing' | 'not_set' | 'not_declared';

/** A system secret nothing declares is an orphan whatever its value; a saved card past its expiry
 *  month is expired (the server sends no status, only `card.expired`); otherwise the vault wins,
 *  then the environment fallback, then whether an enabled declarer needs it. */
export function secretStatus(row: SecretRowData): SecretStatus {
  if (row.kind === 'system' && row.declaredBy.length === 0) return 'not_declared';
  if (row.configured) return row.card?.expired ? 'expired' : 'configured';
  if (row.envFallback) return 'env';
  if (row.required) return 'missing';
  return 'not_set';
}

/** Whether the console can set or change this row's value. Platform keys belong to the
 *  deployment; an orphan (no declarer) can be removed but not set. */
export function canEditValue(row: SecretRowData): boolean {
  return row.kind !== 'platform' && !(row.kind === 'system' && row.declaredBy.length === 0);
}

const BRAND_NAME: Record<SecretCardSummary['brand'], string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', other: 'Card',
};

export function cardBrandName(card: SecretCardSummary): string {
  return BRAND_NAME[card.brand];
}

/** "Visa ••1111 · exp 12/2027" */
export function cardSummaryText(card: SecretCardSummary): string {
  return `${cardBrandName(card)} ••${card.last4} · exp ${card.expiry}`;
}

/** Hostname of a login URL: lower-cased, leading "www." stripped; null when absent or unparseable. */
export function siteHost(loginUrl?: string): string | null {
  if (!loginUrl) return null;
  try {
    return new URL(loginUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // An unparseable URL just has no host; the row still lists, it only skips host search and duplicate hints.
    return null;
  }
}

export interface SecretFilters {
  kind: SecretKind | 'all';
  status: SecretStatus | 'all';
  required: 'required' | 'optional' | 'all';
  search: string;
}

function matchesSearch(row: SecretRowData, needle: string): boolean {
  const haystack = [
    row.name,
    ...row.declaredBy.map(declarerLabel),
    siteHost(row.loginUrl) ?? '',
    row.loginUrl ?? '',
    row.username ?? '',
    ...(row.card ? [row.card.label ?? '', cardBrandName(row.card), row.card.last4] : []),
  ];
  return haystack.some(h => h.toLowerCase().includes(needle));
}

/** Filter groups combine with AND; search is case-insensitive. */
export function filterSecrets(rows: SecretRowData[], f: SecretFilters): SecretRowData[] {
  const needle = f.search.trim().toLowerCase();
  return rows.filter(r =>
    (f.kind === 'all' || r.kind === f.kind) &&
    (f.status === 'all' || secretStatus(r) === f.status) &&
    (f.required === 'all' || (f.required === 'required') === r.required) &&
    (needle === '' || matchesSearch(r, needle)));
}

/** Option counts over all rows, so a chip's number does not change as other filters are applied. */
export function filterCounts(rows: SecretRowData[]): {
  kind: Record<SecretKind | 'all', number>;
  status: Record<SecretStatus, number>;
  required: Record<'required' | 'optional', number>;
} {
  const counts = {
    kind: { all: rows.length, personal: 0, system: 0, platform: 0 },
    status: { configured: 0, expired: 0, env: 0, missing: 0, not_set: 0, not_declared: 0 },
    required: { required: 0, optional: 0 },
  };
  for (const r of rows) {
    counts.kind[r.kind] += 1;
    counts.status[secretStatus(r)] += 1;
    counts.required[r.required ? 'required' : 'optional'] += 1;
  }
  return counts;
}

export type SecretSortKey = 'name' | 'kind' | 'status' | 'updatedAt' | 'lastUsedAt';

const STATUS_ORDER: Record<SecretStatus, number> = {
  missing: 0, expired: 1, not_set: 2, env: 3, not_declared: 4, configured: 5,
};

function compareDates(a: string | null, b: string | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last in both directions
  if (b === null) return -1;
  return (Date.parse(a) - Date.parse(b)) * dir;
}

/** null sort = the default: missing and expired first, then by name. Returns a new array. */
export function sortSecrets(
  rows: SecretRowData[],
  sort: { key: SecretSortKey; dir: 'asc' | 'desc' } | null,
): SecretRowData[] {
  const byName = (a: SecretRowData, b: SecretRowData) => a.name.localeCompare(b.name);
  const byStatus = (a: SecretRowData, b: SecretRowData) => STATUS_ORDER[secretStatus(a)] - STATUS_ORDER[secretStatus(b)];
  if (sort === null) return [...rows].sort((a, b) => byStatus(a, b) || byName(a, b));
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'name': return byName(a, b) * dir;
      case 'kind': return (a.kind.localeCompare(b.kind) * dir) || byName(a, b);
      case 'status': return (byStatus(a, b) * dir) || byName(a, b);
      case 'updatedAt': return compareDates(a.updatedAt, b.updatedAt, dir) || byName(a, b);
      case 'lastUsedAt': return compareDates(a.lastUsedAt, b.lastUsedAt, dir) || byName(a, b);
    }
  });
}

/** For each personal row, the other personal rows sharing its site host; rows with no host are left out. */
export function duplicateSiteHints(rows: SecretRowData[]): Map<string, string[]> {
  const byHost = new Map<string, string[]>();
  for (const r of rows) {
    if (r.kind !== 'personal') continue;
    const host = siteHost(r.loginUrl);
    if (host) byHost.set(host, [...(byHost.get(host) ?? []), r.name]);
  }
  const hints = new Map<string, string[]>();
  for (const names of byHost.values()) {
    if (names.length < 2) continue;
    for (const n of names) hints.set(n, names.filter(o => o !== n));
  }
  return hints;
}

/** "user.aircanada_password" reads as "Aircanada password"; other names are shown as they are. */
export function readableLabel(name: string): string {
  if (!name.startsWith('user.')) return name;
  const words = name.slice('user.'.length).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Text for the "Last used" cell. "Used" means Curia read it. The short date past 30 days
 *  uses the viewer's zone; `timeZone` exists so tests can pin one. */
export function lastUsedText(row: SecretRowData, now: Date, timeZone?: string): string {
  // A recorded read wins even for a boot-read key: some are also read through ctx.secret().
  const then = row.lastUsedAt ? new Date(row.lastUsedAt) : null;
  if (!then || Number.isNaN(then.getTime())) {
    // A boot-read key with no vault value and no environment fallback is never read at all.
    if (row.readAtStartup) return row.configured || row.envFallback ? 'At startup' : 'n/a';
    return row.configured ? 'Never' : 'n/a';
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
}

/** For each saved card, the other cards with the same brand and last four (likely the same card
 *  saved twice); cards of unknown brand are left out. */
export function duplicateCardHints(rows: SecretRowData[]): Map<string, string[]> {
  const byCard = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.card || r.card.brand === 'other') continue;
    const key = `${r.card.brand}:${r.card.last4}`;
    byCard.set(key, [...(byCard.get(key) ?? []), r.name]);
  }
  const hints = new Map<string, string[]>();
  for (const names of byCard.values()) {
    if (names.length < 2) continue;
    for (const n of names) hints.set(n, names.filter(o => o !== n));
  }
  return hints;
}
