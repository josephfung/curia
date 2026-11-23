// limits.ts — deep-dive defaults (#2362). Constants, not config: the existing onboarding
// pattern (see ../constants.ts).

/** How far back the history scan reaches. */
export const WINDOW_DAYS = 90;
/** Pause between Nylas pages (doubles after a 429). */
export const PAGE_DELAY_MS = 1000;
/** Cap on messages read; hitting it ends the scan as truncated. */
export const MAX_MESSAGES = 15000;
/** Cap on Nylas requests; hitting it ends the scan as truncated. */
export const MAX_REQUESTS = 1500;
/** Days of calendar read for the time-and-priorities picture. */
export const CALENDAR_WINDOW_DAYS = 7;
/** Sent messages sampled for the writing-voice document. */
export const VOICE_SAMPLE_SIZE = 30;
/** A correspondent needs this many messages in total, at least one each way, to count as two-way. */
export const TWO_WAY_MIN_MESSAGES = 3;
/** Most contacts backfilled from the scan. */
export const BACKFILL_CAP = 150;
/** A scanning/drafting run whose updatedAt is older than this is considered stalled and resumed. */
export const STALL_MINUTES = 30;
/** Output token cap for each drafting call. */
export const DRAFT_MAX_TOKENS = 16000;
