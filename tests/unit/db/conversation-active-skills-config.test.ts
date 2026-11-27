import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS,
  conversationActiveSkillsIdleTtlMs,
} from '../../../src/db/conversation-active-skills.js';

describe('conversationActiveSkillsIdleTtlMs (#2764)', () => {
  it('honours 0 hours: the schema allows it, and it means nothing carries', () => {
    expect(conversationActiveSkillsIdleTtlMs(0)).toBe(0);
  });

  it('converts positive hours to milliseconds', () => {
    expect(conversationActiveSkillsIdleTtlMs(2)).toBe(2 * 60 * 60 * 1000);
  });

  it('falls back to the 24-hour default when absent, negative or not a number', () => {
    for (const v of [undefined, -1, Number.NaN, '6']) {
      expect(conversationActiveSkillsIdleTtlMs(v)).toBe(CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS);
    }
  });
});
