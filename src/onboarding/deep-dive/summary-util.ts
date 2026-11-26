// summary-util.ts — small pure helpers shared by the history-summary modules (#2362).

/** Evidence on any summary item: the ids it was computed from, newest first, at most 10. */
export type Evidence = { messageIds?: string[]; eventIds?: string[] };

export const EVIDENCE_CAP = 10;

/** An id with the time it sorts by (unix seconds). */
export interface Dated {
  id: string;
  at: number;
}

/** Newest first, ties by id; deduplicated and capped at EVIDENCE_CAP. */
export function newestIds(items: readonly Dated[]): string[] {
  const sorted = [...items].sort((a, b) => b.at - a.at || compareStrings(a.id, b.id));
  const out: string[] = [];
  for (const { id } of sorted) {
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length === EVIDENCE_CAP) break;
  }
  return out;
}

export function messageEvidence(items: readonly Dated[]): Evidence {
  const ids = newestIds(items);
  return ids.length > 0 ? { messageIds: ids } : {};
}

export function eventEvidence(items: readonly Dated[]): Evidence {
  const ids = newestIds(items);
  return ids.length > 0 ? { eventIds: ids } : {};
}

/** Median of the values, rounded to a whole number; null when there are none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value);
}

/** Locale-independent string order, so the output never depends on the host's collation. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normaliseAddress(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

/** Hours rounded to two decimals. */
export function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}
