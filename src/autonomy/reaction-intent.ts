// reaction-intent.ts — channel-agnostic emoji → approve/reject mapping (#1479).
//
// Adapters publish raw emoji (Slack shortcode or unicode). Intent mapping lives
// here so Slack, Signal, and future channels share one config-driven table with
// no channel-specific branching.

export type ReactionIntent = 'approve' | 'reject';

export interface ReactionIntentConfig {
  approve: readonly string[];
  reject: readonly string[];
}

/**
 * Default emoji sets — Slack shortcodes + common unicode glyphs.
 * Generous on approve (casual affirmations), conservative on reject
 * (only clear negative / stop glyphs — not ambiguous faces).
 */
export const DEFAULT_REACTION_INTENTS: ReactionIntentConfig = {
  approve: [
    'thumbsup', '+1', 'white_check_mark', 'heavy_check_mark', 'ok_hand',
    'raised_hands', '100', 'ok',
    '👍', '✅', '✔', '✔️', '👌', '🙌', '💯', '🆗',
  ],
  reject: [
    'thumbsdown', '-1', 'x', 'no_entry', 'no_entry_sign', 'person_gesturing_no',
    '👎', '❌', '🚫', '⛔', '🙅',
  ],
};

/** Fitzpatrick skin-tone modifiers (U+1F3FB–U+1F3FF). */
const FITZPATRICK_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
/** Emoji variation selector-16 (U+FE0F) — present on e.g. ✔️ vs bare ✔. */
const VARIATION_SELECTOR_RE = /\uFE0F/g;
/** Slack skin-tone suffix: `thumbsup::skin-tone-3` or trailing `:skin-tone-3`. */
const SLACK_SKIN_TONE_RE = /::skin-tone-\d+$|:skin-tone-\d+$/i;

/**
 * Normalize a reaction token for intent matching.
 * Strips Slack skin-tone suffixes, unicode Fitzpatrick modifiers, and U+FE0F
 * so skin-toned 👍🏽 / `thumbsup::skin-tone-3` match bare 👍 / `thumbsup`.
 * Exported for unit tests.
 */
export function normalizeReactionEmoji(emoji: string): string {
  let s = emoji.trim();
  if (!s) return '';
  // Strip a single pair of surrounding colons Slack sometimes includes.
  s = s.replace(/^:(.+):$/, '$1');
  // Slack shortcode skin-tone modifier (before lowercasing).
  s = s.replace(SLACK_SKIN_TONE_RE, '');
  // Unicode skin tones + VS16 (order: strip modifiers first, then VS16).
  s = s.replace(FITZPATRICK_RE, '').replace(VARIATION_SELECTOR_RE, '');
  // Shortcodes are ASCII; lowercasing is safe. Unicode glyphs are unchanged.
  return s.toLowerCase();
}

/**
 * Map a reaction emoji to an approval intent.
 * Normalizes skin tones / variation selectors before matching.
 */
export function mapEmojiToIntent(
  emoji: string,
  config: ReactionIntentConfig = DEFAULT_REACTION_INTENTS,
): ReactionIntent | null {
  const key = normalizeReactionEmoji(emoji);
  if (!key) return null;

  const approve = new Set(config.approve.map(normalizeReactionEmoji));
  const reject = new Set(config.reject.map(normalizeReactionEmoji));

  if (approve.has(key)) return 'approve';
  if (reject.has(key)) return 'reject';
  return null;
}
