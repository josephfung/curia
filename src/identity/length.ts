// length.ts — the Detail slider as concrete per-channel length limits (#2143, tone & style
// PR 3).
//
// One table serves three readers, so a calibration changes one place:
//   - the identity block's **Length** section (OfficeIdentityService.compileSystemPromptBlock),
//   - the per-turn reminder the runtime adds to a reply turn's guidance (turnLengthReminder),
//   - the console's Detail preview (GET /api/identity → lengthLimits).
// See docs/wip/2026-10-15-tone-and-style-design.md, "Length bands" and "Per-turn reminder".

/** A row of the length table: the channels that share a limit. */
export type LengthRow = 'message' | 'email' | 'voice';

export const LENGTH_ROWS: readonly LengthRow[] = ['message', 'email', 'voice'];

/** How each row is named in the block and the console. */
export const LENGTH_ROW_LABELS: Record<LengthRow, string> = {
  message: 'Signal, SMS and Slack',
  email: 'Email',
  voice: 'Voice calls',
};

/**
 * Which row a reply channel uses. Explicit on purpose: a channel with no row (`http`
 * console chat, `cli`, `scheduler`, `calendar`, `bullpen`, an agent's internal channel)
 * gets no length reminder, never a guessed limit.
 */
const CHANNEL_ROWS: Readonly<Record<string, LengthRow>> = {
  signal: 'message',
  sms: 'message',
  slack: 'message',
  email: 'email',
  voice: 'voice',
};

/** How a reply channel is named in the per-turn reminder. */
const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  signal: 'Signal',
  sms: 'SMS',
  slack: 'Slack',
  email: 'email',
  voice: 'a voice call',
};

export function lengthRowForChannel(channelId: string): LengthRow | undefined {
  return Object.hasOwn(CHANNEL_ROWS, channelId) ? CHANNEL_ROWS[channelId] : undefined;
}

export interface DetailBand {
  /** The band's top verbosity, inclusive. The last band is 100. */
  maxVerbosity: number;
  label: string;
  limits: Record<LengthRow, string>;
}

/**
 * The Detail bands and their limits. The band boundaries are the slider's long-standing
 * ones; the numbers are calibrated against the style scenarios (40a–40g).
 */
export const DETAIL_BANDS: readonly DetailBand[] = [
  {
    maxVerbosity: 25,
    label: 'Brief',
    limits: {
      message: '1–2 sentences. The answer or outcome only.',
      email: 'Under ~80 words. No warm-up line, no closing summary.',
      voice: 'One sentence.',
    },
  },
  {
    maxVerbosity: 50,
    label: 'Concise',
    limits: {
      message: '1–3 sentences.',
      email: 'Under ~150 words.',
      voice: '1–2 sentences.',
    },
  },
  {
    maxVerbosity: 75,
    label: 'Adaptive',
    limits: {
      message: 'Short paragraphs, as the situation needs.',
      email: 'Under ~250 words.',
      voice: '2–3 sentences.',
    },
  },
  {
    maxVerbosity: 100,
    label: 'Thorough',
    limits: {
      message: 'Thorough; context included.',
      email: 'Thorough; context included.',
      voice: 'A few sentences, then offer more.',
    },
  },
];

/** Every band ends with this: without it, brevity drops required content such as recap items. */
export const LENGTH_EXCEPTION = 'Go longer only when you are asked for detail or the content itself needs the space (six meetings are six lines).';

/**
 * Words that carry nothing, whatever the band: absences and narration. From two production
 * emails, one that explained its next steps and repeated its job instruction, and one that
 * listed what was not there (design, Problem cause 5). Style cases 40f and 40g measure it.
 */
export const CONTENT_LINE = "Say what is there, not what isn't, and don't explain your own next steps or repeat your instructions.";

/** The band for a verbosity score (0–100). */
export function detailBand(verbosity: number): DetailBand {
  return DETAIL_BANDS.find(b => verbosity <= b.maxVerbosity) ?? DETAIL_BANDS[DETAIL_BANDS.length - 1]!;
}

/** The identity block's Length section for a verbosity, one line per row. */
export function lengthSectionLines(verbosity: number): string[] {
  const band = detailBand(verbosity);
  return [
    `**Length (Detail: ${band.label}):**`,
    ...LENGTH_ROWS.map(row => `- ${LENGTH_ROW_LABELS[row]}: ${band.limits[row]}`),
    LENGTH_EXCEPTION,
    CONTENT_LINE,
  ];
}

/**
 * The per-turn reminder for a reply on `channelId`, e.g. "This reply goes out on Signal:
 * 1–2 sentences. The answer or outcome only." Null for a channel with no length row.
 */
export function turnLengthReminder(channelId: string, verbosity: number): string | null {
  const row = lengthRowForChannel(channelId);
  if (!row) return null;
  return `This reply goes out on ${CHANNEL_NAMES[channelId]}: ${detailBand(verbosity).limits[row]}`;
}

/**
 * Every reminder the runtime can render, for prompt-exfiltration marker extraction: a
 * model echoing one into an outbound message should be caught like any other guidance.
 */
export const TURN_LENGTH_REMINDER_TEXTS: readonly string[] = Object.keys(CHANNEL_ROWS).flatMap(channel =>
  DETAIL_BANDS.map(band => turnLengthReminder(channel, band.maxVerbosity)!));
