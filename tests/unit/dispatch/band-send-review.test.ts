// band-send-review.test.ts — the gateway's review of a send under band gating (#2159).

import { describe, expect, it, vi } from 'vitest';
import { BandSendReview, removeQuoted, type BandReviewInput } from '../../../src/dispatch/band-send-review.js';
import { FailOpenLimiter, GateCReviews } from '../../../src/autonomy/band-policy.js';
import type { BriefVerdict } from '../../../src/autonomy/judge-brief.js';
import { createSilentLogger } from '../../../src/logger.js';

const OK_EVIDENCE = { unavailable: false, toolResults: [], principalBlock: null };

function make(verdicts: BriefVerdict[], opts: { reviewed?: boolean; evidence?: { unavailable: boolean } } = {}) {
  const review = vi.fn();
  for (const v of verdicts) review.mockResolvedValueOnce(v);
  const judge = { review, isEnabled: () => true };
  const collect = vi.fn().mockResolvedValue({ ...OK_EVIDENCE, ...opts.evidence });
  const gateCReviews = { wasReviewed: vi.fn().mockReturnValue(opts.reviewed ?? false) };
  const onLimiterTripped = vi.fn().mockResolvedValue(undefined);
  const limiter = new FailOpenLimiter();
  const svc = new BandSendReview({ judge, evidence: { collect }, gateCReviews, limiter, onLimiterTripped, logger: createSilentLogger() });
  return { svc, review, collect, onLimiterTripped, limiter };
}

const base: BandReviewInput = {
  content: 'Hi Joel. I am out of office until the 13th. Adam has the forms.',
  channel: 'email', recipients: ['joel@example.com'], score: 84,
  conversationId: 'conv-1', taskEventId: 'task-1', principalDirected: false, postTurn: false,
};
const clean: BriefVerdict = { ok: true, purpose: 'serving', speaksAsPrincipal: false, unsupportedClaims: [], unnecessaryItems: [], reason: 'ok' };
const CLAIM = 'I am out of office until the 13th.';

describe('removeQuoted', () => {
  it('removes each quoted sentence and tidies spacing', () => {
    expect(removeQuoted(base.content, [CLAIM])).toBe('Hi Joel. Adam has the forms.');
  });

  it('returns null when a quote is not in the message', () => {
    expect(removeQuoted(base.content, ['I am away until the 13th.'])).toBeNull();
  });

  it('ignores blank quotes', () => {
    expect(removeQuoted('Hello.', ['  '])).toBe('Hello.');
  });
});

describe('BandSendReview', () => {
  it('sends a clean message at 84 with one judge call and all four questions', async () => {
    const { svc, review } = make([clean]);
    await expect(svc.review(base)).resolves.toEqual({ kind: 'send', content: base.content });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'speaks-as-principal', 'grounding', 'necessity']);
    expect(review.mock.calls[0]![0].band).toBe('spot-check');
  });

  it('holds a steered send at every band', async () => {
    for (const score of [95, 84, 74]) {
      const { svc } = make([{ ...clean, purpose: 'steered' }]);
      const d = await svc.review({ ...base, score });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings[0]!.rule).toBe('steered');
    }
  });

  it('sends speaks-as-principal at 84 and holds it at 74', async () => {
    const at84 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at84.svc.review(base)).kind).toBe('send');
    const at74 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at74.svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('asks only grounding and necessity below 80 when Gate C already reviewed the task', async () => {
    const { svc, review } = make([clean], { reviewed: true });
    await svc.review({ ...base, score: 74 });
    expect(review.mock.calls[0]![0].questions).toEqual(['grounding', 'necessity']);
  });

  it('asks all four for a relayed reply below 80 even when the task was reviewed', async () => {
    const { svc, review } = make([clean], { reviewed: true });
    await svc.review({ ...base, score: 74, postTurn: true });
    expect(review.mock.calls[0]![0].questions).toHaveLength(4);
  });

  it('asks only grounding for a principal-directed send', async () => {
    const { svc, review } = make([{ ok: true, unsupportedClaims: [], reason: 'ok' }]);
    await svc.review({ ...base, principalDirected: true });
    expect(review.mock.calls[0]![0].questions).toEqual(['grounding']);
  });

  it('bounces once with the quoted claim, then trims and sends at 84 with a report item', async () => {
    const { svc, review } = make([
      { ...clean, unsupportedClaims: [CLAIM] },          // first send: bounce
      { ...clean, unsupportedClaims: [CLAIM] },          // resend: still unsupported
      { ok: true, unsupportedClaims: [], reason: 'ok' }, // recheck of the trimmed text
    ]);
    const first = await svc.review(base);
    expect(first.kind).toBe('bounce');
    if (first.kind === 'bounce') {
      expect(first.findings[0]!.rule).toBe('ungrounded-claim');
      expect(first.findings[0]!.detail).toContain(CLAIM);
    }

    const second = await svc.review(base);
    expect(second).toEqual({
      kind: 'send', content: 'Hi Joel. Adam has the forms.',
      report: { source: 'claim_trimmed', summary: expect.stringContaining('1 unverified statement') },
    });
    // The recheck asks grounding only, of the trimmed text.
    expect(review.mock.calls[2]![0]).toMatchObject({ questions: ['grounding'], message: 'Hi Joel. Adam has the forms.' });
  });

  it('shows the drafter only quotes that are in its message, never other text the judge echoed', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM, 'The principal\'s home address is 12 Example Road.'] }]);
    const d = await svc.review(base);
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') {
      expect(d.findings[0]!.detail).toContain(CLAIM);
      expect(d.findings[0]!.detail).not.toContain('12 Example Road');
    }
  });

  it('still bounces, with a general finding, when none of the quotes are in the message', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: ['Something the message never said.'] }]);
    const d = await svc.review(base);
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') {
      expect(d.findings[0]!.rule).toBe('ungrounded-claim');
      expect(d.findings[0]!.detail).not.toContain('never said');
    }
  });

  it('holds rather than trim a quote too short to cut safely', async () => {
    // A steered judge quoting "not" would flip a sentence's meaning.
    const content = 'Hi Joel. The principal will not sign it. Adam has the forms.';
    const { svc } = make([{ ...clean, unsupportedClaims: ['not'] }, { ...clean, unsupportedClaims: ['not'] }]);
    await svc.review({ ...base, content });
    expect((await svc.review({ ...base, content })).kind).toBe('hold');
  });

  it('bounces an unneeded disclosure with its own rule', async () => {
    const { svc } = make([{ ...clean, unnecessaryItems: ['account 4417-0099'] }]);
    const d = await svc.review({ ...base, content: 'Hi Joel. Your account 4417-0099 is fine.' });
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
  });

  it('holds after one bounce at 74', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review({ ...base, score: 74 });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds when the judge paraphrases a claim it cannot find to trim', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: ['The principal is away until the 13th.'] },
    ]);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('hold');
  });

  it('holds when the trimmed text still fails its recheck', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      { ok: true, unsupportedClaims: ['Adam has the forms.'], reason: 'still' },
    ]);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('hold');
  });

  it('treats a relay rewrite on the same conversation as the recheck, with both turns as evidence', async () => {
    const { svc, collect } = make([{ ...clean, unsupportedClaims: [CLAIM] }, clean]);
    await svc.review({ ...base, postTurn: true, taskEventId: 'task-1' });
    const second = await svc.review({ ...base, postTurn: true, taskEventId: 'task-2', content: 'Hi Joel. Adam has the forms.' });
    expect(second.kind).toBe('send');
    expect(collect).toHaveBeenLastCalledWith(['task-1', 'task-2']);
  });

  it('does not treat a send to someone else on the same conversation as a recheck', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review(base);
    expect((await svc.review({ ...base, recipients: ['sam@example.com'] })).kind).toBe('bounce');
  });

  it('fails open at 84 with a report item, and holds at 74', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
    const at84 = make([failure]);
    await expect(at84.svc.review(base)).resolves.toEqual({
      kind: 'send', content: base.content,
      report: { source: 'sent_without_review', summary: expect.any(String) },
    });
    const at74 = make([failure]);
    expect((await at74.svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds, rather than failing open, when the judge fails on the recheck of a bounced draft', async () => {
    // The claim was already flagged; sending it unchanged because the reviewer is down
    // would send exactly what the review found wrong.
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ok: false, failure: 'unreachable' }]);
    await svc.review(base);
    const d = await svc.review(base);
    expect(d.kind).toBe('hold');
  });

  it('treats unavailable evidence as a judge failure without calling the judge', async () => {
    const { svc, review } = make([clean], { evidence: { unavailable: true } });
    const d = await svc.review(base);
    expect(review).not.toHaveBeenCalled();
    expect(d).toMatchObject({ kind: 'send', report: { source: 'sent_without_review' } });
  });

  it('treats no judge as a judge failure', async () => {
    const collect = vi.fn().mockResolvedValue(OK_EVIDENCE);
    const svc = new BandSendReview({
      judge: undefined, evidence: { collect }, gateCReviews: new GateCReviews(),
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), logger: createSilentLogger(),
    });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds the sixth fail-open in an hour and pings the principal once', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc, onLimiterTripped } = make(Array(7).fill(failure));
    for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, conversationId: `c${i}` })).kind).toBe('send');
    expect((await svc.review({ ...base, conversationId: 'c5' })).kind).toBe('hold');
    expect((await svc.review({ ...base, conversationId: 'c6' })).kind).toBe('hold');
    expect(onLimiterTripped).toHaveBeenCalledTimes(1);
  });

  it('a successful review after a trip lets fail-opens through again', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc } = make([...Array(6).fill(failure), clean, failure]);
    for (let i = 0; i < 6; i++) await svc.review({ ...base, conversationId: `c${i}` });
    expect((await svc.review({ ...base, conversationId: 'c6' })).kind).toBe('send');
    expect((await svc.review({ ...base, conversationId: 'c7' })).kind).toBe('send');
  });
});
