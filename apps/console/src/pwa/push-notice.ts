// A console notice from GET /api/push/config (#2341, #2412). Both the banner
// and the notifications panel read it, so they accept the same kinds.

export interface PushNotice {
  id: string;
  kind: 'dead' | 'setup' | 'paired';
  detail: string;
}

export function isNotice(value: unknown): value is PushNotice {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && (row['kind'] === 'dead' || row['kind'] === 'setup' || row['kind'] === 'paired')
    && typeof row['detail'] === 'string';
}
