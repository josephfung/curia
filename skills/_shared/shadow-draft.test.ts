import { describe, it, expect } from 'vitest';
import {
  buildShadowJudgePrompt,
  parseShadowJudgeResult,
  parseShadowDoc,
  SHADOW_DOC_TYPE,
} from './shadow-draft.js';

describe('buildShadowJudgePrompt', () => {
  it('includes each pair id and both bodies and asks for substantive equivalence', () => {
    const p = buildShadowJudgePrompt([
      { sourceMessageId: 'm1', subject: 'Re: meeting', shadowBody: 'Thursday 3pm works.', sentBody: 'Let us do Thursday at 3.' },
    ]);
    expect(p).toContain('m1');
    expect(p).toContain('Thursday 3pm works.');
    expect(p).toMatch(/decision|recommendation|outcome/i);
    expect(p).toMatch(/same_decision/);
  });
});

describe('parseShadowJudgeResult', () => {
  it('parses a JSON array of judgements', () => {
    const out = parseShadowJudgeResult('[{"source_message_id":"m1","same_decision":true,"reason":"both confirm Thursday"}]');
    expect(out).toEqual([{ sourceMessageId: 'm1', sameDecision: true, reason: 'both confirm Thursday' }]);
  });
  it('tolerates surrounding prose and skips malformed entries', () => {
    const out = parseShadowJudgeResult('Here you go:\n[{"source_message_id":"m2","same_decision":false,"reason":"diverged"},{"bad":1}]\ndone');
    expect(out).toEqual([{ sourceMessageId: 'm2', sameDecision: false, reason: 'diverged' }]);
  });
  it('returns [] on unparseable text', () => {
    expect(parseShadowJudgeResult('no json here')).toEqual([]);
  });
});

describe('parseShadowDoc', () => {
  it('skips already-reconciled shadows', () => {
    expect(
      parseShadowDoc({
        type: SHADOW_DOC_TYPE,
        frontmatter: {
          source_message_id: 'm1',
          reconciled_at: '2026-07-01T00:00:00.000Z',
        },
        body: 'hi',
      }),
    ).toBeNull();
  });
});
