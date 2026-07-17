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

describe('parseShadowJudgeResult (strict, all-or-nothing)', () => {
  it('parses a complete response covering the expected ids exactly', () => {
    const out = parseShadowJudgeResult(
      'Here you go:\n[{"source_message_id":"m1","same_decision":true,"reason":"both confirm Thursday"},{"source_message_id":"m2","same_decision":false,"reason":"diverged"}]\ndone',
      ['m1', 'm2'],
    );
    expect(out).not.toBeNull();
    expect(out!.get('m1')).toEqual({ sourceMessageId: 'm1', sameDecision: true, reason: 'both confirm Thursday' });
    expect(out!.get('m2')).toEqual({ sourceMessageId: 'm2', sameDecision: false, reason: 'diverged' });
  });

  it('returns null on a malformed entry (whole batch fails)', () => {
    expect(
      parseShadowJudgeResult('[{"source_message_id":"m1","same_decision":true},{"bad":1}]', ['m1', 'm2']),
    ).toBeNull();
  });

  it('returns null when a pair is missing from the response', () => {
    expect(
      parseShadowJudgeResult('[{"source_message_id":"m1","same_decision":true,"reason":"x"}]', ['m1', 'm2']),
    ).toBeNull();
  });

  it('returns null on a duplicate id or an unexpected extra id', () => {
    expect(
      parseShadowJudgeResult(
        '[{"source_message_id":"m1","same_decision":true,"reason":"x"},{"source_message_id":"m1","same_decision":false,"reason":"y"}]',
        ['m1'],
      ),
    ).toBeNull();
    expect(
      parseShadowJudgeResult(
        '[{"source_message_id":"m1","same_decision":true,"reason":"x"},{"source_message_id":"m9","same_decision":true,"reason":"z"}]',
        ['m1'],
      ),
    ).toBeNull();
  });

  it('returns null on unparseable text', () => {
    expect(parseShadowJudgeResult('no json here', ['m1'])).toBeNull();
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
