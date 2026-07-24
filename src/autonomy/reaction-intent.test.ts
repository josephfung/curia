import { describe, it, expect } from 'vitest';
import {
  mapEmojiToIntent,
  normalizeReactionEmoji,
  DEFAULT_REACTION_INTENTS,
} from './reaction-intent.js';

describe('normalizeReactionEmoji', () => {
  it('strips Slack ::skin-tone-N suffixes', () => {
    expect(normalizeReactionEmoji('thumbsup::skin-tone-3')).toBe('thumbsup');
    expect(normalizeReactionEmoji('+1::skin-tone-2')).toBe('+1');
    expect(normalizeReactionEmoji('ok_hand::skin-tone-5')).toBe('ok_hand');
  });

  it('strips unicode Fitzpatrick modifiers', () => {
    // 👍🏽 = 👍 + medium skin tone (U+1F3FD)
    expect(normalizeReactionEmoji('👍🏽')).toBe('👍');
    // 👍🏻 / 👍🏿
    expect(normalizeReactionEmoji('👍🏻')).toBe('👍');
    expect(normalizeReactionEmoji('👍🏿')).toBe('👍');
    expect(normalizeReactionEmoji('👎🏻')).toBe('👎');
  });

  it('strips U+FE0F variation selector', () => {
    // ✔️ = ✔ + VS16
    expect(normalizeReactionEmoji('✔️')).toBe(normalizeReactionEmoji('✔'));
    expect(mapEmojiToIntent('✔️')).toBe('approve');
  });

  it('strips surrounding colons', () => {
    expect(normalizeReactionEmoji(':thumbsup:')).toBe('thumbsup');
  });
});

describe('mapEmojiToIntent', () => {
  it('maps Slack shortcodes to approve', () => {
    expect(mapEmojiToIntent('thumbsup')).toBe('approve');
    expect(mapEmojiToIntent('+1')).toBe('approve');
    expect(mapEmojiToIntent('white_check_mark')).toBe('approve');
    expect(mapEmojiToIntent('ok_hand')).toBe('approve');
    expect(mapEmojiToIntent('raised_hands')).toBe('approve');
    expect(mapEmojiToIntent('100')).toBe('approve');
  });

  it('maps unicode glyphs to approve/reject', () => {
    expect(mapEmojiToIntent('👍')).toBe('approve');
    expect(mapEmojiToIntent('✅')).toBe('approve');
    expect(mapEmojiToIntent('👌')).toBe('approve');
    expect(mapEmojiToIntent('🙌')).toBe('approve');
    expect(mapEmojiToIntent('💯')).toBe('approve');
    expect(mapEmojiToIntent('👎')).toBe('reject');
    expect(mapEmojiToIntent('❌')).toBe('reject');
    expect(mapEmojiToIntent('🚫')).toBe('reject');
    expect(mapEmojiToIntent('⛔')).toBe('reject');
    expect(mapEmojiToIntent('🙅')).toBe('reject');
  });

  it('maps skin-toned Slack shortcodes to intent', () => {
    expect(mapEmojiToIntent('thumbsup::skin-tone-3')).toBe('approve');
    expect(mapEmojiToIntent('thumbsdown::skin-tone-4')).toBe('reject');
    expect(mapEmojiToIntent(':ok_hand::skin-tone-2:')).toBe('approve');
  });

  it('maps skin-toned unicode glyphs to intent', () => {
    expect(mapEmojiToIntent('👍🏽')).toBe('approve');
    expect(mapEmojiToIntent('👍🏾')).toBe('approve');
    expect(mapEmojiToIntent('👎🏻')).toBe('reject');
  });

  it('strips surrounding colons and is case-insensitive for shortcodes', () => {
    expect(mapEmojiToIntent(':thumbsup:')).toBe('approve');
    expect(mapEmojiToIntent('ThumbsUp')).toBe('approve');
  });

  it('returns null for unmapped emoji (including ambiguous faces)', () => {
    expect(mapEmojiToIntent('heart')).toBeNull();
    expect(mapEmojiToIntent('🎉')).toBeNull();
    expect(mapEmojiToIntent('😬')).toBeNull();
    expect(mapEmojiToIntent('👀')).toBeNull();
    expect(mapEmojiToIntent('')).toBeNull();
  });

  it('honors custom config', () => {
    expect(mapEmojiToIntent('heart', {
      approve: ['heart'],
      reject: DEFAULT_REACTION_INTENTS.reject,
    })).toBe('approve');
  });
});
