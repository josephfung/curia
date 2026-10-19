import { describe, expect, it } from 'vitest';
import {
  CONTENT_LINE,
  DETAIL_BANDS,
  LENGTH_EXCEPTION,
  LENGTH_ROWS,
  detailBand,
  lengthRowForChannel,
  lengthSectionLines,
  turnLengthReminder,
  TURN_LENGTH_REMINDER_TEXTS,
} from '../../../src/identity/length.js';

describe('length table (#2143)', () => {
  it('maps exactly the channels that have a limit, and nothing else', () => {
    expect(lengthRowForChannel('signal')).toBe('message');
    expect(lengthRowForChannel('sms')).toBe('message');
    expect(lengthRowForChannel('slack')).toBe('message');
    expect(lengthRowForChannel('email')).toBe('email');
    expect(lengthRowForChannel('voice')).toBe('voice');
    // Console chat, cli, scheduler and internal channels get no guessed limit.
    for (const channel of ['http', 'cli', 'scheduler', 'calendar', 'bullpen', 'internal', 'toString', '']) {
      expect(lengthRowForChannel(channel), channel).toBeUndefined();
    }
  });

  it('keeps the Detail slider band boundaries', () => {
    expect(DETAIL_BANDS.map(b => b.maxVerbosity)).toEqual([25, 50, 75, 100]);
    expect([0, 25, 26, 50, 51, 75, 76, 100].map(v => detailBand(v).label))
      .toEqual(['Brief', 'Brief', 'Concise', 'Concise', 'Adaptive', 'Adaptive', 'Thorough', 'Thorough']);
  });

  it('never renders an empty or undefined limit', () => {
    for (const band of DETAIL_BANDS) {
      for (const row of LENGTH_ROWS) expect(band.limits[row].trim().length, `${band.label} ${row}`).toBeGreaterThan(0);
    }
    for (const text of TURN_LENGTH_REMINDER_TEXTS) expect(text).not.toMatch(/undefined|: $/);
  });

  it('renders the block section: header, one line per channel row, the exception and the content line', () => {
    expect(lengthSectionLines(15)).toEqual([
      '**Length (Detail: Brief):**',
      '- Signal, SMS and Slack: 1–2 sentences. The answer or outcome only.',
      '- Email: Under ~80 words. No warm-up line, no closing summary.',
      '- Voice calls: One sentence.',
      LENGTH_EXCEPTION,
      CONTENT_LINE,
    ]);
  });

  it('names the reply channel and its limit in the per-turn reminder', () => {
    expect(turnLengthReminder('signal', 15)).toBe('This reply goes out on Signal: 1–2 sentences. The answer or outcome only.');
    expect(turnLengthReminder('email', 60)).toBe('This reply goes out on email: Under ~250 words.');
    expect(turnLengthReminder('http', 15)).toBeNull();
    expect(turnLengthReminder('scheduler', 15)).toBeNull();
  });

  it('lists every reminder the runtime can render, for the exfiltration markers', () => {
    expect(TURN_LENGTH_REMINDER_TEXTS).toContain(turnLengthReminder('slack', 90));
    expect(TURN_LENGTH_REMINDER_TEXTS).toHaveLength(5 * DETAIL_BANDS.length);
  });
});
