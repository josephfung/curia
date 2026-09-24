import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { VOICE_GREETING_USER_MESSAGE } from '../../../src/channels/voice/greeting.js';
import {
  CONTENT_BLOCK_REWRITE_MARKER,
  HISTORICAL_SYNTHETIC_LIKE_PATTERNS,
  LATE_SPECIALIST_RESULT_MARKER,
} from '../../../src/memory/synthetic-user-turn.js';
import { buildContentBlockRewriteTask } from '../../../src/dispatch/content-block-relay.js';
import { normalizeAddTurnAttribution } from '../../../src/memory/contact-recent-history.js';

const MIGRATIONS_DIR = new URL('../../../src/db/migrations/', import.meta.url);

describe('HISTORICAL_SYNTHETIC_LIKE_PATTERNS', () => {
  it('is anchored at the start of the content, so no pattern can match mid-message', () => {
    for (const pattern of HISTORICAL_SYNTHETIC_LIKE_PATTERNS) {
      expect(pattern.startsWith('%')).toBe(false);
      expect(pattern.endsWith('%')).toBe(true);
    }
  });

  it('covers the builders that actually mint these briefs', () => {
    // If a builder's opening line changes, its pattern must change with it —
    // otherwise historical rows silently stop being classified.
    const rewriteBrief = buildContentBlockRewriteTask('blocked text', [
      { rule: 'llm-judge-audience-leak', detail: 'wrong recipient' },
    ]);
    expect(rewriteBrief.startsWith(CONTENT_BLOCK_REWRITE_MARKER)).toBe(true);
    expect(HISTORICAL_SYNTHETIC_LIKE_PATTERNS).toContain(`${CONTENT_BLOCK_REWRITE_MARKER}%`);
    expect(HISTORICAL_SYNTHETIC_LIKE_PATTERNS).toContain(`${LATE_SPECIALIST_RESULT_MARKER}%`);
    expect(HISTORICAL_SYNTHETIC_LIKE_PATTERNS).toContain(`${VOICE_GREETING_USER_MESSAGE}%`);
  });
});

describe('historical classification is carried by a migration', () => {
  it('has some migration covering every pattern', async () => {
    // Deliberately scans all migrations rather than pinning to 092. A pattern
    // added later needs its OWN migration: node-pg-migrate records a migration as
    // run, so editing 092 after it has shipped repairs nothing on any existing
    // database while still turning this assertion green.
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql'));
    const sql = (
      await Promise.all(files.map(f => readFile(new URL(f, MIGRATIONS_DIR), 'utf8')))
    ).join('\n');

    for (const pattern of HISTORICAL_SYNTHETIC_LIKE_PATTERNS) {
      // The patterns already carry SQL-escaped quotes, so they appear verbatim
      // inside the migration's string literals.
      expect(sql, `no migration classifies rows matching ${pattern}`).toContain(`'${pattern}'`);
    }
  });
});

describe('normalizeAddTurnAttribution synthetic flag', () => {
  it('only an explicit true marks a row as Curia\'s own', () => {
    // Everything else is a person's words. A truthy-but-not-true value reaching
    // this from a forwarded payload must not silently exclude a human turn from
    // the shared-conversation check.
    expect(normalizeAddTurnAttribution({ synthetic: true }).synthetic).toBe(true);
    expect(normalizeAddTurnAttribution({ synthetic: false }).synthetic).toBe(false);
    expect(normalizeAddTurnAttribution({}).synthetic).toBe(false);
    expect(normalizeAddTurnAttribution(undefined).synthetic).toBe(false);
    expect(normalizeAddTurnAttribution({ synthetic: 'yes' } as never).synthetic).toBe(false);
    expect(normalizeAddTurnAttribution({ synthetic: 1 } as never).synthetic).toBe(false);
  });
});
