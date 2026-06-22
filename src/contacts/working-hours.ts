//
// Pure helpers for the principal's working-hours profile (issue #392).
//
// Working hours are NOT a canonical contact column (see canonical-attribute-guard.ts),
// so they are stored as a KG fact on the principal's node and surfaced to agents by the
// entity-context assembler. The wizard collects them structured; the setup endpoint
// serializes to a human-readable string for the fact value (richer for KG browsing and
// better for LLM consumption than raw JSON).

/** Structured working hours. days: 0=Sunday .. 6=Saturday. */
export interface WorkingHours {
  start: string; // "HH:MM" 24h
  end: string;   // "HH:MM" 24h
  days: number[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Validate + normalize an untrusted value into WorkingHours, or null if malformed. */
export function validateWorkingHours(value: unknown): WorkingHours | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== 'string' || !HHMM.test(v.start)) return null;
  if (typeof v.end !== 'string' || !HHMM.test(v.end)) return null;
  if (!Array.isArray(v.days) || v.days.length === 0) return null;
  const days: number[] = [];
  for (const d of v.days) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null;
    if (!days.includes(d)) days.push(d);
  }
  days.sort((a, b) => a - b);
  return { start: v.start, end: v.end, days };
}

/** "09:00" → "9:00 AM"; "17:00" → "5:00 PM"; "00:00" → "12:00 AM". */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  const hour = h!;
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(m!).padStart(2, '0')} ${meridiem}`;
}

/** Render days: a fully-contiguous run becomes "Mon–Fri"; otherwise "Mon, Wed, Fri". */
function formatDays(days: number[]): string {
  const isContiguous =
    days.length >= 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  if (isContiguous) return `${DAY_ABBR[days[0]!]}–${DAY_ABBR[days[days.length - 1]!]}`;
  return days.map((d) => DAY_ABBR[d]).join(', ');
}

/** Structured working hours → readable string stored in the KG fact value. */
export function serializeWorkingHours(wh: WorkingHours): string {
  return `${formatDays(wh.days)}, ${formatTime(wh.start)}–${formatTime(wh.end)}`;
}
