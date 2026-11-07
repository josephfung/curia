// band-send-review.test.ts — the gateway's review of a send under band gating (#2159).

import { describe, expect, it, vi } from 'vitest';
import * as bandReviewModule from '../../../src/dispatch/band-send-review.js';
import { BandSendReview, BLOCK_REASON, type BandReviewDecision, type BandReviewInput } from '../../../src/dispatch/band-send-review.js';
import { FailOpenLimiter } from '../../../src/autonomy/band-policy.js';
import type { BriefDetectedItem, BriefVerdict, DisclosureRuling, SendAuthority } from '../../../src/autonomy/judge-brief.js';
import type { ContactTier } from '../../../src/contacts/types.js';
import { createSilentLogger } from '../../../src/logger.js';

const OK_EVIDENCE = { unavailable: false, toolResults: [], principalBlock: null };

function make(
  verdicts: BriefVerdict[],
  opts: {
    evidence?: {
      unavailable?: boolean; authority?: SendAuthority; originContent?: string; originUnresolved?: true;
      decisions?: Array<{ counterparty: string; label: string; decision: 'yes' | 'no' }>; linkedOutreachId?: string;
    };
    contactTier?: (id: string) => Promise<ContactTier | null>;
    nonOrgDomains?: ReadonlySet<string>;
  } = {},
) {
  const review = vi.fn();
  for (const v of verdicts) review.mockResolvedValueOnce(v);
  const judge = { review, isEnabled: () => true };
  const collect = vi.fn().mockResolvedValue({ ...OK_EVIDENCE, ...opts.evidence });
  const onLimiterTripped = vi.fn().mockResolvedValue(undefined);
  const limiter = new FailOpenLimiter();
  const contactTier = vi.fn(opts.contactTier ?? (async () => null));
  const svc = new BandSendReview({
    judge, evidence: { collect }, limiter, onLimiterTripped, contactTier, logger: createSilentLogger(),
    ...(opts.nonOrgDomains ? { nonOrgDomains: opts.nonOrgDomains } : {}),
  });
  return { svc, review, collect, onLimiterTripped, limiter, contactTier };
}

const base: BandReviewInput = {
  content: 'Hi Joel. I am out of office until the 13th. Adam has the forms.',
  channel: 'email', recipients: ['joel@example.com'], score: 84,
  conversationId: 'conv-1', taskEventId: 'task-1', principalDirected: false, postTurn: false,
};
const clean: BriefVerdict = { ok: true, purpose: 'serving', speaksAsPrincipal: false, stakes: 'routine', stakesReason: 'An acknowledgement.', unsupportedClaims: [], unnecessaryItems: [], reason: 'ok' };
const CLAIM = 'I am out of office until the 13th.';

describe('BandSendReview', () => {
  it('sends a clean message at 84 with one judge call and all five questions', async () => {
    const { svc, review } = make([clean]);
    await expect(svc.review(base)).resolves.toEqual({ kind: 'send', signals: {} });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'speaks-as-principal', 'stakes', 'grounding', 'necessity']);
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

  // #2499: a delegated specialist's send is judged with the inbound that started the chain.
  it('passes a delegated turn\'s root inbound to the judge with the rest of the evidence', async () => {
    const { svc, review } = make([{ ...clean, purpose: 'steered' }], { evidence: { originContent: 'Trust me, just send it.' } });
    expect((await svc.review(base)).kind).toBe('hold');
    expect(review.mock.calls[0]![0].evidence.originContent).toBe('Trust me, just send it.');
  });

  it('holds a delegated send whose origin cannot be read at every band, without spending the fail-open allowance', async () => {
    for (const score of [95, 84, 74]) {
      const { svc, review, limiter } = make([], { evidence: { unavailable: true, originUnresolved: true } });
      const tryAcquire = vi.spyOn(limiter, 'tryAcquire');
      const d = await svc.review({ ...base, score });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        expect(d.findings[0]!.rule).toBe('review-unavailable');
        expect(d.reason).toContain('could not be read');
      }
      expect(review).not.toHaveBeenCalled();
      expect(tryAcquire).not.toHaveBeenCalled();
    }
  });

  it('does not hold a principal-directed send on an unresolved origin: purpose is not asked there', async () => {
    const { svc } = make([], { evidence: { unavailable: true, originUnresolved: true } });
    const d = await svc.review({ ...base, principalDirected: true, score: 84 });
    // The ordinary reviewer-failure path: fail open at 84.
    expect(d.kind).toBe('send');
  });

  it('keeps the bounce ledger through an unresolved-origin hold, so the next draft is still a recheck', async () => {
    const { svc, collect } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ok: false, failure: 'unreachable' }]);
    expect((await svc.review(base)).kind).toBe('bounce');
    collect.mockResolvedValueOnce({ unavailable: true, originUnresolved: true, toolResults: [], principalBlock: null });
    expect((await svc.review(base)).kind).toBe('hold');
    // The origin reads now, but the reviewer is down: a bounced draft holds rather than failing open.
    const d = await svc.review(base);
    expect(d.kind).toBe('hold');
    // The recheck hold, not the stakes-unrated one a cleared ledger would also give.
    if (d.kind === 'hold') expect(d.reason).toContain('reviewer was unavailable to recheck it');
  });

  it('carries the redaction-placeholder finding on an unresolved-origin hold', async () => {
    const { svc } = make([], { evidence: { unavailable: true, originUnresolved: true } });
    const d = await svc.review({ ...base, subject: 'Re: [REDACTED: PHONE_NUMBER]' });
    expect(d.kind).toBe('hold');
    if (d.kind === 'hold') {
      expect(d.reason).toContain('could not be read');
      expect(d.findings.map((f) => f.rule)).toEqual(['review-unavailable', 'redaction-token']);
    }
  });

  // Spot-check signals (#2159 Phase 3): the gateway records them with the pool row.
  it('reports speaks-as-principal as a signal on a send at 85', async () => {
    const { svc } = make([{ ...clean, speaksAsPrincipal: true }]);
    await expect(svc.review({ ...base, score: 85 })).resolves.toEqual({
      kind: 'send', signals: { speaksAsPrincipal: true },
    });
  });

  it('reports bounced when a draft that bounced once passes on the recheck', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, clean]);
    await svc.review(base);
    const d = await svc.review({ ...base, content: 'Hi Joel. Adam has the forms.' });
    expect(d.kind).toBe('send');
    if (d.kind === 'send') expect(d.signals?.bounced).toBe(true);
  });

  it('sends speaks-as-principal at 84 and holds it at 74', async () => {
    const at84 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at84.svc.review(base)).kind).toBe('send');
    const at74 = make([{ ...clean, speaksAsPrincipal: true }]);
    expect((await at74.svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('asks all five questions below 80 too: Gate C leaves sends to this review', async () => {
    const { svc, review } = make([clean]);
    await svc.review({ ...base, score: 74 });
    expect(review.mock.calls[0]![0].questions).toHaveLength(5);
  });

  it('forwards the principal recipients to the judge', async () => {
    const { svc, review } = make([clean]);
    await svc.review({ ...base, recipients: ['sam@example.com', 'joel@example.com'], principalRecipients: ['sam@example.com'] });
    expect(review.mock.calls[0]![0].principalRecipients).toEqual(['sam@example.com']);
  });

  it('asks only grounding for a principal-directed send', async () => {
    const { svc, review } = make([{ ok: true, unsupportedClaims: [], reason: 'ok' }]);
    await svc.review({ ...base, principalDirected: true });
    expect(review.mock.calls[0]![0].questions).toEqual(['grounding']);
  });

  // #2474: a principal-directed send from the principal's own mailbox.
  describe('principal mailbox sends (#2474)', () => {
    const mailbox: BandReviewInput = { ...base, principalDirected: true, senderProfile: 'principal-mailbox' };
    const item: BriefDetectedItem = { id: 'P1', label: 'PHONE_NUMBER', text: '416-555-0199', field: 'body' };

    it('asks no question of its own for a principal-written draft, only disclosure when items exist', async () => {
      const { svc, review } = make([{ ok: true, disclosures: [{ id: 'P1', basis: 'directed', requested: false, reason: 'told to' }], reason: 'ok' }]);
      await svc.review({ ...mailbox, draftAuthor: 'principal', detectedItems: [item] });
      expect(review.mock.calls[0]![0].questions).toEqual(['disclosure']);
      expect(review.mock.calls[0]![0].senderProfile).toBe('principal-mailbox');
    });

    it('asks purpose and grounding for a Curia-written draft', async () => {
      const { svc, review } = make([{ ok: true, purpose: 'serving', unsupportedClaims: [], reason: 'ok' }]);
      await svc.review({ ...mailbox, draftAuthor: 'curia' });
      expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'grounding']);
      expect(review.mock.calls[0]![0].senderProfile).toBe('principal-mailbox');
    });

    it('asks only purpose for a draft Curia edited: a steering check, not a fact-check of the principal\'s words', async () => {
      const { svc, review } = make([{ ok: true, purpose: 'serving', reason: 'ok' }]);
      await svc.review({ ...mailbox, draftAuthor: 'curia-edited' });
      expect(review.mock.calls[0]![0].questions).toEqual(['purpose']);
    });

    it('leaves every other review\'s brief without a sender profile', async () => {
      const { svc, review } = make([clean, { ok: true, unsupportedClaims: [], reason: 'ok' }]);
      await svc.review(base);
      await svc.review({ ...base, principalDirected: true });
      expect(review.mock.calls[0]![0]).not.toHaveProperty('senderProfile');
      expect(review.mock.calls[1]![0]).not.toHaveProperty('senderProfile');
      expect(review.mock.calls[1]![0].questions).toEqual(['grounding']);
    });
  });

  it('bounces once with the quoted claim, then blocks a second occurrence at 84 with no recheck call', async () => {
    const { svc, review } = make([
      { ...clean, unsupportedClaims: [CLAIM] }, // first send: bounce
      { ...clean, unsupportedClaims: [CLAIM] }, // resend: still unsupported
    ]);
    const first = await svc.review(base);
    expect(first.kind).toBe('bounce');
    if (first.kind === 'bounce') {
      expect(first.findings[0]!.rule).toBe('ungrounded-claim');
      expect(first.findings[0]!.detail).toContain(CLAIM);
    }

    const second = await svc.review(base);
    expect(second.kind).toBe('block');
    if (second.kind === 'block') {
      expect(second.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);
      expect(second.reason).toBe(BLOCK_REASON);
    }
    // Nothing is cut and no grounding-only recheck runs: two judge calls in all.
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('blocks a second occurrence of unneeded disclosures at 84 with the unneeded-disclosure rule', async () => {
    const content = 'Hi Joel. Your account 4417-0099 is fine.';
    const { svc, review } = make([
      { ...clean, unnecessaryItems: ['account 4417-0099'] },
      { ...clean, unnecessaryItems: ['account 4417-0099'] },
    ]);
    await svc.review({ ...base, content });
    const d = await svc.review({ ...base, content });
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('blocks again on a third review that still has findings, and sends a clean fourth', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      clean,
    ]);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('block');
    expect((await svc.review(base)).kind).toBe('block');
    expect((await svc.review(base)).kind).toBe('send');
    // The entry was cleared by the clean send: a new finding bounces afresh.
  });

  it('clears the ledger entry when a draft after a block is clean', async () => {
    const { svc } = make([
      { ...clean, unsupportedClaims: [CLAIM] },
      { ...clean, unsupportedClaims: [CLAIM] },
      clean,
      { ...clean, unsupportedClaims: [CLAIM] },
    ]);
    await svc.review(base);
    await svc.review(base);
    expect((await svc.review(base)).kind).toBe('send');
    expect((await svc.review(base)).kind).toBe('bounce');
  });

  it('refreshes the ledger time on a block, so a third draft inside the window still blocks', async () => {
    let t = 1_000_000;
    const review = vi.fn();
    for (let i = 0; i < 3; i++) review.mockResolvedValueOnce({ ...clean, unsupportedClaims: [CLAIM] });
    const svc = new BandSendReview({
      judge: { review, isEnabled: () => true }, evidence: { collect: vi.fn().mockResolvedValue(OK_EVIDENCE) },
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createSilentLogger(), now: () => t,
    });
    await svc.review(base);
    t += 20 * 60_000;
    expect((await svc.review(base)).kind).toBe('block');
    t += 20 * 60_000; // 40 minutes after the first bounce, 20 after the block
    expect((await svc.review(base)).kind).toBe('block');
  });

  describe('incident drafts: a flagged sentence that survives one rewrite is never sent', () => {
    const incidents = [
      { draft: "Thanks for reaching out. I can't share Sam's contact details at this point. If you'd like, I can pass your note along to him.", flagged: "I can't share Sam's contact details at this point." },
      { draft: "Thanks for following up. I've passed your request along to Sam; he'll reach out directly this week.", flagged: "he'll reach out directly this week." },
      { draft: 'Email is the best route to Sam: sam@example.com. Send a couple of times that suit you and he will confirm one.', flagged: 'Send a couple of times that suit you and he will confirm one.' },
    ];
    for (const { draft, flagged } of incidents) {
      it(`blocks at 84 and holds at 74: ${flagged}`, async () => {
        for (const [score, kind] of [[84, 'block'], [74, 'hold']] as const) {
          const { svc } = make([{ ...clean, unsupportedClaims: [flagged] }, { ...clean, unsupportedClaims: [flagged] }]);
          const input = { ...base, content: draft, score };
          expect((await svc.review(input)).kind).toBe('bounce');
          expect((await svc.review(input)).kind).toBe(kind);
        }
      });
    }
  });

  it('exports no cut-text helper', () => {
    expect('removeQuoted' in bandReviewModule).toBe(false);
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

  it('bounces an unneeded disclosure with its own rule', async () => {
    const { svc } = make([{ ...clean, unnecessaryItems: ['account 4417-0099'] }]);
    const d = await svc.review({ ...base, content: 'Hi Joel. Your account 4417-0099 is fine.' });
    expect(d.kind).toBe('bounce');
    if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
  });

  it('holds a second occurrence at 74', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review({ ...base, score: 74 });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('treats a relay rewrite on the same conversation as the recheck, with both turns as evidence', async () => {
    const { svc, collect } = make([{ ...clean, unsupportedClaims: [CLAIM] }, clean]);
    await svc.review({ ...base, postTurn: true, taskEventId: 'task-1' });
    const second = await svc.review({ ...base, postTurn: true, taskEventId: 'task-2', content: 'Hi Joel. Adam has the forms.' });
    expect(second.kind).toBe('send');
    expect(collect).toHaveBeenLastCalledWith(['task-1', 'task-2'], { conversationId: 'conv-1', counterparties: ['joel@example.com'] });
  });

  it('adds what the relay reported to the principal to the evidence (#2312)', async () => {
    const { svc, review, collect } = make([clean, clean, clean, clean]);
    collect.mockResolvedValue({ ...OK_EVIDENCE, reportsToPrincipal: ['Earlier note.'] });

    await svc.review({ ...base, reportedToPrincipal: 'Provider asked for your number.' });
    expect(review.mock.calls[0]![0].evidence.reportsToPrincipal).toEqual(['Provider asked for your number.', 'Earlier note.']);

    // Redacted and clipped like the collector's evidence.
    await svc.review({ ...base, conversationId: 'conv-3', reportedToPrincipal: `key sk-ant-abcdefghijklmnopqrstuvwxyz0123 ${'x'.repeat(5000)}` });
    const [leading] = review.mock.calls[1]![0].evidence.reportsToPrincipal as string[];
    expect(leading).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(leading).toContain('[REDACTED]');
    expect(leading!.length).toBeLessThanOrEqual(2_001);

    // Without a note the collected reports pass through untouched.
    await svc.review({ ...base, conversationId: 'conv-2' });
    expect(review.mock.calls[2]![0].evidence.reportsToPrincipal).toEqual(['Earlier note.']);
  });

  it('does not treat a send to someone else on the same conversation as a recheck', async () => {
    const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ...clean, unsupportedClaims: [CLAIM] }]);
    await svc.review(base);
    expect((await svc.review({ ...base, recipients: ['sam@example.com'] })).kind).toBe('bounce');
  });

  // Only a principal-directed send fails open: every other send's stakes are unrated (#2473).
  const directed: BandReviewInput = { ...base, principalDirected: true };

  it('fails open at 84 with a report item for a principal-directed send, and holds at 74', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
    const at84 = make([failure]);
    await expect(at84.svc.review(directed)).resolves.toEqual({
      kind: 'send',
      report: { source: 'sent_without_review', summary: expect.any(String) },
    });
    const at74 = make([failure]);
    expect((await at74.svc.review({ ...directed, score: 74 })).kind).toBe('hold');
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
    const d = await svc.review(directed);
    expect(review).not.toHaveBeenCalled();
    expect(d).toMatchObject({ kind: 'send', report: { source: 'sent_without_review' } });
  });

  it('treats no judge as a judge failure', async () => {
    const collect = vi.fn().mockResolvedValue(OK_EVIDENCE);
    const svc = new BandSendReview({
      judge: undefined, evidence: { collect },
      limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createSilentLogger(),
    });
    expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
  });

  it('holds the sixth fail-open in an hour and pings the principal once', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc, onLimiterTripped } = make(Array(7).fill(failure));
    for (let i = 0; i < 5; i++) expect((await svc.review({ ...directed, conversationId: `c${i}` })).kind).toBe('send');
    expect((await svc.review({ ...directed, conversationId: 'c5' })).kind).toBe('hold');
    expect((await svc.review({ ...directed, conversationId: 'c6' })).kind).toBe('hold');
    expect(onLimiterTripped).toHaveBeenCalledTimes(1);
  });

  it('a successful review after a trip lets fail-opens through again', async () => {
    const failure: BriefVerdict = { ok: false, failure: 'malformed' };
    const { svc } = make([...Array(6).fill(failure), clean, failure]);
    for (let i = 0; i < 6; i++) await svc.review({ ...directed, conversationId: `c${i}` });
    expect((await svc.review({ ...directed, conversationId: 'c6' })).kind).toBe('send');
    expect((await svc.review({ ...directed, conversationId: 'c7' })).kind).toBe('send');
  });

  // Stakes (#2473): what a send that speaks for the principal commits them to sets the score it
  // needs to go out without asking.
  describe('stakes', () => {
    const speaks = (stakes: 'routine' | 'commitment' | 'financial_or_legal', stakesReason = 'Why it was rated so.'): Extract<BriefVerdict, { ok: true }> =>
      ({ ...(clean as Extract<BriefVerdict, { ok: true }>), speaksAsPrincipal: true, stakes, stakesReason });
    const cases = [
      ['routine', 79, 'hold'], ['routine', 80, 'send'], ['routine', 100, 'send'],
      ['commitment', 79, 'hold'], ['commitment', 80, 'hold'], ['commitment', 89, 'hold'], ['commitment', 90, 'send'], ['commitment', 100, 'send'],
      ['financial_or_legal', 79, 'hold'], ['financial_or_legal', 80, 'hold'], ['financial_or_legal', 89, 'hold'],
      ['financial_or_legal', 90, 'hold'], ['financial_or_legal', 100, 'hold'],
    ] as const;
    for (const [stakes, score, kind] of cases) {
      it(`${kind}s a ${stakes} send at ${score}`, async () => {
        const { svc } = make([speaks(stakes)]);
        const d = await svc.review({ ...base, score });
        expect(d.kind).toBe(kind);
        if (d.kind === 'send') expect(d.signals?.speaksAsPrincipal).toBe(true);
        if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['speaks-as-principal']);
      });
    }

    it('does not gate a send that does not speak for the principal, whatever its rating', async () => {
      const { svc } = make([{ ...clean, stakes: 'financial_or_legal' }]);
      expect((await svc.review({ ...base, score: 80 })).kind).toBe('send');
    });

    it('names the rating and the judge\'s reason on the hold, on one line and capped', async () => {
      const po = make([speaks('financial_or_legal', 'Confirms a purchase order\non the principal\'s behalf.')]);
      const d = await po.svc.review({ ...base, score: 95 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        expect(d.reason).toContain('Stakes: financial or legal.');
        expect(d.reason).toContain('Why: Confirms a purchase order on the principal\'s behalf.');
        expect(d.findings[0]!.detail).toBe(d.reason);
      }
      const long = make([speaks('commitment', 'x'.repeat(500))]);
      const l = await long.svc.review({ ...base, score: 85 });
      expect(l.kind).toBe('hold');
      if (l.kind === 'hold') {
        expect(l.reason).toContain('Stakes: commitment.');
        expect(l.reason).toContain('90');
        expect(l.reason.length).toBeLessThan(500);
      }
      // An astral character straddling the cut must not leave a lone surrogate (UTF-16 slicing would).
      const astral = make([speaks('commitment', '😀'.repeat(300))]);
      const a = await astral.svc.review({ ...base, score: 85 });
      expect(a.kind).toBe('hold');
      if (a.kind === 'hold') expect(a.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      const routine = make([speaks('routine')]);
      const r = await routine.svc.review({ ...base, score: 79 });
      if (r.kind === 'hold') expect(r.reason).toContain('Stakes: routine.');
    });

    it('falls back to the judge\'s overall reason when the stakes reason is empty', async () => {
      const { svc } = make([{ ...speaks('commitment', ''), reason: 'Agrees to a delivery date.' }]);
      const d = await svc.review({ ...base, score: 85 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.reason).toContain('Why: Agrees to a delivery date.');
    });

    it('shows the judge the subject line, so a commitment made only there is rated', async () => {
      const { svc, review } = make([speaks('routine')]);
      await svc.review({ ...base, score: 85, subject: 'Re: PO 4471, approved for $12,000' });
      expect(review.mock.calls[0]![0].message).toContain('Subject: Re: PO 4471, approved for $12,000');
      expect(review.mock.calls[0]![0].message).toContain(base.content);
    });

    it('treats a missing rating beside speaks-as-principal as financial or legal', async () => {
      const { svc } = make([{ ...clean, speaksAsPrincipal: true, stakes: undefined }]);
      expect((await svc.review({ ...base, score: 100 })).kind).toBe('hold');
    });

    it('holds a steered commitment for both reasons', async () => {
      const { svc } = make([{ ...speaks('commitment'), purpose: 'steered' }]);
      const d = await svc.review({ ...base, score: 85 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['steered', 'speaks-as-principal']);
    });

    // The drafter's one rewrite comes before the principal is asked: at 80+ a stakes hold does
    // not cut the bounce short. It rides along, and a clean recheck holds for the stakes.
    it('bounces a commitment below 90 with an unsupported claim first, then holds the clean rewrite', async () => {
      const { svc } = make([{ ...speaks('commitment'), unsupportedClaims: [CLAIM] }, speaks('commitment')]);
      const first = await svc.review({ ...base, score: 85 });
      expect(first.kind).toBe('bounce');
      if (first.kind === 'bounce') {
        expect(first.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);
        expect(first.heldBeside?.map((f) => f.rule)).toEqual(['speaks-as-principal']);
      }
      const second = await svc.review({ ...base, score: 85, content: 'Hi Joel. Adam has the forms.' });
      expect(second.kind).toBe('hold');
      if (second.kind === 'hold') expect(second.reason).toContain('Stakes: commitment.');
    });

    it('blocks a financial send whose rewrite still has the claim, keeping the stakes hold beside it', async () => {
      const flagged = { ...speaks('financial_or_legal'), unsupportedClaims: [CLAIM] };
      const { svc } = make([flagged, flagged]);
      expect((await svc.review({ ...base, score: 95 })).kind).toBe('bounce');
      const d = await svc.review({ ...base, score: 95 });
      expect(d.kind).toBe('block');
      if (d.kind === 'block') expect(d.heldBeside?.map((f) => f.rule)).toEqual(['speaks-as-principal']);
    });

    it('still holds first below 80, as before', async () => {
      const { svc } = make([{ ...speaks('routine'), unsupportedClaims: [CLAIM] }]);
      expect((await svc.review({ ...base, score: 74 })).kind).toBe('hold');
    });

    it('does not ask the stakes of a principal-directed send', async () => {
      const { svc, review } = make([{ ok: true, unsupportedClaims: [], reason: 'ok' }]);
      expect((await svc.review({ ...base, principalDirected: true, score: 100 })).kind).toBe('send');
      expect(review.mock.calls[0]![0].questions).not.toContain('stakes');
    });

    for (const failure of ['unreachable', 'malformed', 'disabled'] as const) {
      it(`holds on a ${failure} judge at every band without using the fail-open cap`, async () => {
        for (const score of [100, 90, 80, 79, 74]) {
          const { svc, limiter, onLimiterTripped } = make([{ ok: false, failure }]);
          const tryAcquire = vi.spyOn(limiter, 'tryAcquire');
          const d = await svc.review({ ...base, score });
          expect(d.kind).toBe('hold');
          if (d.kind === 'hold') {
            expect(d.findings.map((f) => f.rule)).toEqual(['review-unavailable']);
            expect(d.reason).toContain('Stakes: financial or legal (unrated)');
          }
          expect(d).not.toHaveProperty('report');
          expect(tryAcquire).not.toHaveBeenCalled();
          expect(onLimiterTripped).not.toHaveBeenCalled();
        }
      });
    }

    it('leaves the fail-open allowance whole for principal-directed sends after stakes holds', async () => {
      const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
      const { svc } = make(Array(10).fill(failure));
      for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, conversationId: `s${i}` })).kind).toBe('hold');
      for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, principalDirected: true, conversationId: `d${i}` })).kind).toBe('send');
    });

    it('holds an unrated send whose only personal details are quoted, rather than dropping the quote', async () => {
      const Q: BriefDetectedItem = { id: 'P1', label: 'phone_us', text: '415-555-0100', field: 'quote' };
      const { svc } = make([{ ok: false, failure: 'unreachable' }]);
      const d = await svc.review({ ...base, detectedItems: [Q] });
      expect(d.kind).toBe('hold');
      expect(d).not.toHaveProperty('dropQuote');
    });

    // The scenario cases (#2473), at the review: a routine ack sends at 85; a PO confirmation
    // holds at 95; a delivery commitment holds at 85 and sends at 92.
    it('sends a routine scheduling ack at 85', async () => {
      const { svc } = make([speaks('routine', 'Confirms a meeting time.')]);
      expect((await svc.review({ ...base, content: 'Thursday at 2 works, see you then.', score: 85 })).kind).toBe('send');
    });

    it('holds a purchase-order confirmation at 95', async () => {
      const { svc } = make([speaks('financial_or_legal', 'Confirms a purchase order.')]);
      expect((await svc.review({ ...base, content: 'Confirmed, please go ahead with the purchase order.', score: 95 })).kind).toBe('hold');
    });

    it('holds "we can deliver by Friday" at 85 and sends it at 92', async () => {
      const content = 'Yes, we can deliver the report by Friday.';
      const at85 = make([speaks('commitment', 'Commits to a delivery date.')]);
      expect((await at85.svc.review({ ...base, content, score: 85 })).kind).toBe('hold');
      const at92 = make([speaks('commitment', 'Commits to a delivery date.')]);
      expect((await at92.svc.review({ ...base, content, score: 92 })).kind).toBe('send');
    });
  });

  // Authority-aware PII (#2312): the judge rules on each detected item; code decides who
  // has the authority and what each ruling does.
  describe('detected personal data', () => {
    const SIN = '046 454 286';
    const content = `Hi Joel. Sam's SIN is ${SIN}.`;
    const P1: BriefDetectedItem = { id: 'P1', label: 'sin_ca', text: SIN, field: 'body' };
    const P2: BriefDetectedItem = { id: 'P2', label: 'phone_us', text: '415-555-0100', field: 'body' };
    const pii: BandReviewInput = { ...base, content, detectedItems: [P1] };

    type Originator = NonNullable<SendAuthority['originator']>;
    const principal: Originator = { contactId: 'c-principal', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true };
    const curia: Originator = { contactId: 'c-curia', systemRole: 'agent', tier: null, channel: 'internal', authenticated: false };
    const outsider: Originator = { contactId: 'x@evil.example', systemRole: null, tier: 'unknown', channel: 'email', authenticated: false };
    const trusted: Originator = { contactId: 'c-trusted', systemRole: null, tier: 'trusted', channel: 'email', authenticated: true };

    const live: SendAuthority = { originator: principal, liveTurn: true };
    const standing: SendAuthority = {
      originator: curia, liveTurn: false,
      boundTask: { taskId: 't-child', title: 'Book the call', description: null, originator: curia },
      rootTask: { taskId: 't-root', title: 'Set up the clinic', description: null, originator: principal },
    };
    const fromOutsider: SendAuthority = { originator: outsider, liveTurn: false };
    const fromTrusted: SendAuthority = { originator: trusted, liveTurn: false };

    const ruling = (basis: DisclosureRuling['basis'], requested = false, id = 'P1'): DisclosureRuling => ({ id, basis, requested, reason: `ruled on ${SIN}` });
    type OkVerdict = Extract<BriefVerdict, { ok: true }>;
    const withRulings = (...disclosures: DisclosureRuling[]): OkVerdict => ({ ...(clean as OkVerdict), disclosures });
    const directedOnly = (...disclosures: DisclosureRuling[]): BriefVerdict => ({ ok: true, unsupportedClaims: [], disclosures, reason: 'ok' });

    it('sends a principal-directed item, asking disclosure alongside grounding with the items', async () => {
      const { svc, review } = make([directedOnly(ruling('directed'))], { evidence: { authority: live } });
      await expect(svc.review({ ...pii, principalDirected: true })).resolves.toEqual({ kind: 'send', signals: {} });
      expect(review.mock.calls[0]![0].questions).toEqual(['grounding', 'disclosure']);
      expect(review.mock.calls[0]![0].detectedItems).toEqual([P1]);
    });

    it('asks disclosure after the other five when the send is not principal-directed', async () => {
      const { svc, review } = make([withRulings(ruling('directed'))], { evidence: { authority: live } });
      await svc.review(pii);
      expect(review.mock.calls[0]![0].questions).toEqual(['purpose', 'speaks-as-principal', 'stakes', 'grounding', 'necessity', 'disclosure']);
    });

    it('bounces an unauthorized item before holding a commitment for its stakes (#2473)', async () => {
      const commitment: OkVerdict = { ...withRulings(ruling('inferred')), speaksAsPrincipal: true, stakes: 'commitment', stakesReason: 'Agrees to a date.' };
      const { svc } = make([commitment], { evidence: { authority: fromOutsider } });
      const d = await svc.review({ ...pii, score: 85 });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        expect(d.heldBeside?.map((f) => f.rule)).toEqual(['speaks-as-principal']);
      }
    });

    it('keeps the stakes finding beside a claim bounce when a trusted-directed item holds (#2473)', async () => {
      const verdict: OkVerdict = { ...withRulings(ruling('directed')), unsupportedClaims: ['The clinic opens at 9.'], speaksAsPrincipal: true, stakes: 'commitment', stakesReason: 'Agrees to a date.' };
      const { svc } = make([verdict], { evidence: { authority: fromTrusted }, contactTier: async () => 'trusted' });
      const d = await svc.review({ ...pii, score: 85 });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.heldBeside?.map((f) => f.rule)).toEqual(['speaks-as-principal', 'pii-not-authorized']);
    });

    it('does not ask disclosure, or pass items, when nothing was detected', async () => {
      for (const detectedItems of [undefined, []]) {
        const { svc, review } = make([clean]);
        await svc.review({ ...base, detectedItems });
        expect(review.mock.calls[0]![0].questions).not.toContain('disclosure');
        expect(review.mock.calls[0]![0].detectedItems).toBeUndefined();
      }
    });

    it('sends an inferred item under a standing task whose root the principal created at 84, and holds it at 74', async () => {
      const at84 = make([withRulings(ruling('inferred'))], { evidence: { authority: standing } });
      expect((await at84.svc.review(pii)).kind).toBe('send');
      const at74 = make([withRulings(ruling('inferred'))], { evidence: { authority: standing } });
      const d = await at74.svc.review({ ...pii, score: 74 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
    });

    it('counts the bound task\'s principal originator as principal authority', async () => {
      const bound: SendAuthority = { originator: curia, liveTurn: false, boundTask: { taskId: 't', title: 'x', description: null, originator: principal } };
      const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: bound } });
      expect((await svc.review(pii)).kind).toBe('send');
    });

    // Narrow authority (#2312): the principal set the task, but the drafting turn is not theirs,
    // so a directed ruling counts as inferred: sent at 80+, held below.
    it('treats a directed ruling as inferred when only the bound or root task is the principal\'s', async () => {
      const bound: SendAuthority = { originator: curia, liveTurn: false, boundTask: { taskId: 't', title: 'x', description: null, originator: principal } };
      for (const authority of [bound, standing]) {
        const at84 = make([withRulings(ruling('directed'))], { evidence: { authority } });
        expect((await at84.svc.review(pii)).kind).toBe('send');
        const at74 = make([withRulings(ruling('directed'))], { evidence: { authority } });
        const d = await at74.svc.review({ ...pii, score: 74 });
        expect(d.kind).toBe('hold');
        if (d.kind === 'hold') {
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
          expect(d.reason).toContain('sin_ca');
          expect(d.reason).toContain('a task the principal set');
          expect(d.reason).not.toContain(SIN);
        }
      }
    });

    it('keeps a full directed ruling at 74 for a live principal turn or a wake the principal originated', async () => {
      const wake: SendAuthority = {
        originator: principal, liveTurn: false,
        boundTask: { taskId: 't', title: 'x', description: null, originator: curia },
      };
      for (const authority of [live, wake]) {
        const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority } });
        expect((await svc.review({ ...pii, score: 74 })).kind).toBe('send');
      }
    });

    // A reply linked to outreach (#2312): the sender is the outsider who replied; the link says
    // which task their message answers. Only a strong link to the principal's task is authority.
    describe('a reply linked to the outreach of a task', () => {
      type Linked = NonNullable<SendAuthority['linkedTask']>;
      // base sends to joel@example.com: the row lists him, so the link covers this send.
      const ROW = { addresses: ['joel@example.com'], contactIds: [], domains: [] };
      const link = (
        strength: Linked['strength'],
        originator: SendAuthority['originator'] = principal,
        over: Partial<Linked> = {},
      ): SendAuthority => ({
        originator: outsider, liveTurn: false,
        linkedTask: {
          taskId: 't-link', title: 'Book physio', originator, linkKind: strength === 'strong' ? 'org-domain' : 'inferred', strength,
          counterparty: ROW, ...over,
        },
      });

      it('gives a strong link to the principal\'s task principal-task authority: inferred sends at 84, holds at 74', async () => {
        for (const basis of ['inferred', 'directed'] as const) {
          const at84 = make([withRulings(ruling(basis, true))], { evidence: { authority: link('strong') } });
          expect((await at84.svc.review(pii)).kind).toBe('send');
          const at74 = make([withRulings(ruling(basis, true))], { evidence: { authority: link('strong') } });
          const d = await at74.svc.review({ ...pii, score: 74 });
          expect(d.kind).toBe('hold');
          if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        }
      });

      it('counts the linked task\'s project root when the principal directed that instead', async () => {
        const authority = link('strong', curia, { root: { taskId: 't-root', title: 'Set up the clinic', originator: principal } });
        const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority } });
        expect((await svc.review(pii)).kind).toBe('send');
      });

      it('gives a task-less strong link the principal directed the same authority', async () => {
        const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('strong', principal, { taskId: null, title: null }) } });
        expect((await svc.review(pii)).kind).toBe('send');
      });

      it('gives a weak link no authority, but makes a requesting recipient askable: held at 84 and 74', async () => {
        for (const score of [84, 74]) {
          const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: link('weak') } });
          const d = await svc.review({ ...pii, score });
          expect(d.kind).toBe('hold');
          if (d.kind === 'hold') {
            expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
            expect(d.reason).toContain('the recipient asked');
            expect(d.reason).not.toContain(SIN);
          }
        }
      });

      it('bounces a weak link\'s item the recipient did not ask for, offering to ask the principal', async () => {
        const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('weak') } });
        const d = await svc.review(pii);
        expect(d.kind).toBe('bounce');
        if (d.kind === 'bounce') {
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
          expect(d.findings[0]!.detail).toContain('ask the principal');
        }
      });

      it('gives a link to a task the principal did not direct no authority and no askability', async () => {
        for (const originator of [curia, outsider, null]) {
          for (const strength of ['strong', 'weak'] as const) {
            const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: link(strength, originator) } });
            const d = await svc.review(pii);
            expect(d.kind).toBe('bounce');
            if (d.kind === 'bounce') expect(d.findings[0]!.detail).not.toContain('ask the principal');
          }
        }
      });

      // The link covers the counterparties Curia contacted for the task, and nobody else.
      describe('only for a send to the linked counterparties', () => {
        const offRow: BandReviewInput = { ...pii, recipients: ['dana@other.example'] };

        it('bounces a strong link\'s item sent to someone the row does not list', async () => {
          const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('strong') } });
          expect((await svc.review(offRow)).kind).toBe('bounce');
        });

        it('bounces a weak link\'s requested item sent off the row, with no offer to ask', async () => {
          const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: link('weak') } });
          const d = await svc.review(offRow);
          expect(d.kind).toBe('bounce');
          if (d.kind === 'bounce') expect(d.findings[0]!.detail).not.toContain('ask the principal');
        });

        it('gives no link authority when any non-principal recipient is off the row', async () => {
          const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('strong') } });
          expect((await svc.review({ ...pii, recipients: ['joel@example.com', 'dana@other.example'] })).kind).toBe('bounce');
        });

        it('ignores the principal among the recipients', async () => {
          const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: link('strong') } });
          const d = await svc.review({ ...pii, recipients: ['Joel@Example.com', 'joe@principal.example'], principalRecipients: ['JOE@principal.example'] });
          expect(d.kind).toBe('send');
        });

        it('covers a recipient at one of the row\'s org domains, unless it is a principal domain', async () => {
          const atDomain = link('strong', principal, { counterparty: { addresses: [], contactIds: [], domains: ['acme.example'] } });
          const input = { ...pii, recipients: ['front-desk@mail.acme.example'] };
          const ok = make([withRulings(ruling('inferred'))], { evidence: { authority: atDomain } });
          expect((await ok.svc.review(input)).kind).toBe('send');
          const own = make([withRulings(ruling('inferred'))], { evidence: { authority: atDomain }, nonOrgDomains: new Set(['mail.acme.example']) });
          expect((await own.svc.review(input)).kind).toBe('bounce');
        });

        it('covers a recipient whose address or contact id the row has, or who is the linked sender', async () => {
          const none = { addresses: [], contactIds: [], domains: [] };
          const byRowAddress = link('strong', principal, { counterparty: { ...none, addresses: ['joel@example.com'] } });
          const a = make([withRulings(ruling('inferred'))], { evidence: { authority: byRowAddress } });
          expect((await a.svc.review(pii)).kind).toBe('send');

          const byRowContact = link('strong', principal, { counterparty: { ...none, contactIds: ['c-joel'] } });
          const b = make([withRulings(ruling('inferred'))], { evidence: { authority: byRowContact } });
          expect((await b.svc.review({ ...pii, recipientContactIds: { 'joel@example.com': 'C-JOEL' } })).kind).toBe('send');

          const joelUuid = '55555555-5555-4555-8555-555555555555';
          const bySenderContact: SendAuthority = { ...link('strong', principal, { counterparty: none }), originator: { ...outsider, contactId: joelUuid } };
          const c = make([withRulings(ruling('inferred'))], { evidence: { authority: bySenderContact } });
          expect((await c.svc.review({ ...pii, recipientContactIds: { 'joel@example.com': joelUuid } })).kind).toBe('send');

          // The linked sender's contact id never stands in for an address.
          const d = make([withRulings(ruling('inferred'))], { evidence: { authority: bySenderContact } });
          expect((await d.svc.review(pii)).kind).not.toBe('send');
        });

        it('gives no link authority or askability when the row could not be read', async () => {
          const unread = link('strong', principal, { counterparty: undefined });
          delete unread.linkedTask!.counterparty;
          const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: unread } });
          const d = await svc.review(pii);
          expect(d.kind).toBe('bounce');
          if (d.kind === 'bounce') expect(d.findings[0]!.detail).not.toContain('ask the principal');
        });
      });
    });

    it('bounces an item the judge called directed when an outsider originated the work, naming only the label', async () => {
      const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: fromOutsider } });
      const d = await svc.review(pii);
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        expect(d.findings[0]!.detail).toContain('sin_ca');
        expect(d.findings[0]!.detail).not.toContain(SIN);
        expect(d.findings[0]!.detail).not.toContain('ask the principal');
      }
    });

    it('bounces when the evidence carries no authority at all', async () => {
      const { svc } = make([withRulings(ruling('directed'))]);
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    // A trusted contact is not the principal, and their tier grants no send_on_behalf: the
    // principal approves the disclosure, at any score (#2312). Held, not an ask: the recipient
    // did not ask, the trusted contact did.
    it('holds a trusted contact\'s directed item for the principal at any score', async () => {
      for (const score of [74, 84, 95]) {
        const { svc, contactTier } = make([withRulings(ruling('directed'))], {
          evidence: { authority: fromTrusted }, contactTier: async () => 'trusted',
        });
        const d = await svc.review({ ...pii, score, recipientTier: 'known' });
        expect(d).toMatchObject({ kind: 'hold', reason: expect.stringContaining('a trusted contact asked for the principal\'s personal details (sin_ca)') });
        expect(d).not.toHaveProperty('ask');
        expect(contactTier).toHaveBeenCalledWith('c-trusted');
      }
    });

    // Review Focus 5 (#2312): the drafting turn's own trusted originator directed it, so the
    // principal's root task does not demote the directive to "inferred".
    it('holds a trusted contact\'s directive inside a principal-rooted task too, even at 80+', async () => {
      const rooted: SendAuthority = { ...fromTrusted, rootTask: { taskId: 't-root', title: 'Set up the clinic', description: null, originator: principal } };
      const { svc, contactTier } = make([withRulings(ruling('directed'))], { evidence: { authority: rooted }, contactTier: async () => 'trusted' });
      // The task's authority alone would send an inferred item at 84; the trusted directive holds.
      expect((await svc.review({ ...pii, score: 84 })).kind).toBe('hold');
      expect(contactTier).toHaveBeenCalledWith('c-trusted');
      // An inferred item under the same authority still takes the task path: held below 80.
      const inferred = make([withRulings(ruling('inferred'))], { evidence: { authority: rooted }, contactTier: async () => 'trusted' });
      expect((await inferred.svc.review({ ...pii, score: 74 })).kind).toBe('hold');
      // A demoted originator falls back to the task path: the directive counts as inferred.
      const demoted = make([withRulings(ruling('directed'))], { evidence: { authority: rooted }, contactTier: async () => 'known' });
      expect((await demoted.svc.review({ ...pii, score: 74 })).kind).toBe('hold');
    });

    it('names each held label once', async () => {
      const P3: BriefDetectedItem = { ...P1, id: 'P3', text: '046 454 287' };
      const { svc } = make([withRulings(ruling('directed'), ruling('directed', false, 'P3'))], {
        evidence: { authority: fromTrusted }, contactTier: async () => 'trusted',
      });
      const d = await svc.review({ ...pii, detectedItems: [P1, P3] });
      expect(d).toMatchObject({ kind: 'hold', reason: expect.stringContaining('personal details (sin_ca)') });
    });

    it('gives no trusted authority to a contact demoted since, or whose tier cannot be read', async () => {
      for (const contactTier of [async () => 'known' as const, async () => null, async () => { throw new Error('db down'); }]) {
        const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: fromTrusted }, contactTier });
        expect((await svc.review(pii)).kind).toBe('bounce');
      }
    });

    it('gives no trusted authority when the originating message was not authenticated', async () => {
      const { svc, contactTier } = make([withRulings(ruling('directed'))], {
        evidence: { authority: { originator: { ...trusted, authenticated: false }, liveTurn: false } }, contactTier: async () => 'trusted',
      });
      expect((await svc.review(pii)).kind).toBe('bounce');
      expect(contactTier).not.toHaveBeenCalled();
    });

    it('does not let a trusted contact unlock an inferred item', async () => {
      const { svc } = make([withRulings(ruling('inferred'))], { evidence: { authority: fromTrusted }, contactTier: async () => 'trusted' });
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    it('holds an unsupported item a known recipient asked for, and bounces it for an unknown one', async () => {
      const known = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      const held = await known.svc.review({ ...pii, recipientTier: 'known' });
      expect(held.kind).toBe('hold');
      if (held.kind === 'hold') expect(held.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);

      const unknown = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      expect((await unknown.svc.review({ ...pii, recipientTier: 'unknown' })).kind).toBe('bounce');
    });

    it('bounces an unrequested item to an askable recipient, offering to ask the principal', async () => {
      const { svc } = make([withRulings(ruling('unsupported', false))], { evidence: { authority: fromOutsider } });
      const d = await svc.review({ ...pii, recipientTier: 'trusted' });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings[0]!.detail).toContain('or ask the principal');
    });

    it('blocks a second draft that still has an unsupported item at 84, and holds it at 74', async () => {
      for (const [score, kind] of [[84, 'block'], [74, 'hold']] as const) {
        const { svc } = make([withRulings(ruling('unsupported')), withRulings(ruling('unsupported'))], { evidence: { authority: fromOutsider } });
        expect((await svc.review({ ...pii, score })).kind).toBe('bounce');
        const d = await svc.review({ ...pii, score });
        expect(d.kind).toBe(kind);
        if (d.kind === 'block') {
          expect(d.reason).toBe(BLOCK_REASON);
          expect(d.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        }
      }
    });

    it('sends the rewrite once the item is gone, reporting the bounce', async () => {
      const { svc } = make([withRulings(ruling('unsupported')), clean], { evidence: { authority: fromOutsider } });
      await svc.review(pii);
      await expect(svc.review({ ...base, content: 'Hi Joel.' })).resolves.toEqual({ kind: 'send', signals: { bounced: true } });
    });

    it('bounces on a judge failure with items present, never failing open, then holds the rewrite', async () => {
      const failure: BriefVerdict = { ok: false, failure: 'unreachable' };
      const { svc, onLimiterTripped } = make([failure, failure], { evidence: { authority: live } });
      const first = await svc.review(pii);
      expect(first.kind).toBe('bounce');
      if (first.kind === 'bounce') {
        expect(first.findings.map((f) => f.rule)).toEqual(['pii-not-authorized']);
        expect(first.findings[0]!.detail).toContain('sin_ca');
      }
      expect((await svc.review(pii)).kind).toBe('hold');
      expect(onLimiterTripped).not.toHaveBeenCalled();
    });

    it('does not spend the fail-open allowance on a send it bounced for its items', async () => {
      const failure: BriefVerdict = { ok: false, failure: 'malformed' };
      const { svc } = make(Array(11).fill(failure));
      for (let i = 0; i < 6; i++) expect((await svc.review({ ...pii, conversationId: `p${i}` })).kind).toBe('bounce');
      // Five ordinary fail-opens (principal-directed sends) are still available.
      for (let i = 0; i < 5; i++) expect((await svc.review({ ...base, principalDirected: true, conversationId: `c${i}` })).kind).toBe('send');
    });

    it('holds on a judge failure with items present below 80', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      expect((await svc.review({ ...pii, score: 74 })).kind).toBe('hold');
    });

    it('treats a missing ruling as a judge failure', async () => {
      const { svc } = make([withRulings(ruling('directed')), withRulings(ruling('directed'))], { evidence: { authority: live } });
      const input = { ...pii, detectedItems: [P1, P2] };
      expect((await svc.review(input)).kind).toBe('bounce');
      expect((await svc.review(input)).kind).toBe('hold');
    });

    it('treats a malformed verdict as a judge failure', async () => {
      const { svc } = make([{ ok: false, failure: 'malformed' }, { ok: false, failure: 'malformed' }], { evidence: { authority: live } });
      expect((await svc.review(pii)).kind).toBe('bounce');
      expect((await svc.review(pii)).kind).toBe('hold');
    });

    it('does not ask the judge about more than ten items and bounces them all', async () => {
      const many = Array.from({ length: 11 }, (_, i): BriefDetectedItem => ({ id: `P${i + 1}`, label: 'phone_us', text: `415-555-01${String(i).padStart(2, '0')}`, field: 'body' }));
      const { svc, review } = make([clean, clean], { evidence: { authority: live } });
      const input = { ...base, detectedItems: many, recipientTier: 'known' as const };
      const d = await svc.review(input);
      expect(review.mock.calls[0]![0].questions).not.toContain('disclosure');
      expect(review.mock.calls[0]![0].detectedItems).toBeUndefined();
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') {
        expect(d.findings).toEqual([{ rule: 'pii-not-authorized', detail: 'This message contains more personal details than can be reviewed at once. Send fewer, or split the message.' }]);
      }
      expect((await svc.review(input)).kind).toBe('block');
    });

    // A steered hold no longer does (#2333): see "a personal-details bounce beat a hold that is only for steering".
    it('takes the strictest outcome: a speaks-as-principal hold below 80 beats a PII bounce', async () => {
      const { svc } = make([{ ...withRulings(ruling('unsupported')), speaksAsPrincipal: true }], { evidence: { authority: fromOutsider } });
      const d = await svc.review({ ...pii, score: 74 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(['speaks-as-principal']);
    });

    it('takes the strictest outcome: a claim bounce beats an authorized item, and both bounce together', async () => {
      const claimOnly = make([{ ...withRulings(ruling('directed')), unsupportedClaims: [CLAIM] }], { evidence: { authority: live } });
      const d = await claimOnly.svc.review({ ...pii, content: `${content} ${CLAIM}` });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);

      const both = make([{ ...withRulings(ruling('unsupported')), unsupportedClaims: [CLAIM] }], { evidence: { authority: fromOutsider } });
      const d2 = await both.svc.review({ ...pii, content: `${content} ${CLAIM}` });
      expect(d2.kind).toBe('bounce');
      if (d2.kind === 'bounce') expect(d2.findings.map((f) => f.rule)).toEqual(['ungrounded-claim', 'pii-not-authorized']);
    });

    it('takes the strictest outcome: a PII block at 84 beats a speaks-as-principal send', async () => {
      const { svc } = make([withRulings(ruling('unsupported')), { ...withRulings(ruling('unsupported')), speaksAsPrincipal: true }], { evidence: { authority: fromOutsider } });
      await svc.review(pii);
      expect((await svc.review(pii)).kind).toBe('block');
    });

    // A yes to the ask would send the other finding too: the drafter fixes it first (#2312).
    it('lets a bounce beat an ask hold, whichever rule raised which', async () => {
      // A claim bounce (other rules) beside an ask (disclosure).
      const claim = make([{ ...withRulings(ruling('unsupported', true)), unsupportedClaims: [CLAIM] }], { evidence: { authority: fromOutsider } });
      const d1 = await claim.svc.review({ ...pii, content: `${content} ${CLAIM}`, recipientTier: 'known' });
      expect(d1.kind).toBe('bounce');
      if (d1.kind === 'bounce') expect(d1.findings.map((f) => f.rule)).toEqual(['ungrounded-claim']);
      // Either order: the bounce is returned as it is.
      const bounce: BandReviewDecision = { kind: 'bounce', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] };
      const ask: BandReviewDecision = {
        kind: 'hold', reason: 'Held', findings: [{ rule: 'pii-not-authorized', detail: 'Held' }],
        ask: { labels: ['sin_ca'], requester: 'joel@example.com', counterparties: ['joel@example.com'] },
      };
      expect(bandReviewModule.combine(bounce, ask)).toBe(bounce);
      expect(bandReviewModule.combine(ask, bounce)).toBe(bounce);
      // A hold that is not an ask still beats a bounce.
      const plain: BandReviewDecision = { kind: 'hold', reason: 'Held', findings: [{ rule: 'steered', detail: 'Held' }] };
      expect(bandReviewModule.combine(bounce, plain)).toBe(plain);
      expect(bandReviewModule.combine(plain, bounce)).toBe(plain);
      // The recheck, with the claim gone, asks.
      const recheck = make([{ ...withRulings(ruling('unsupported', true)), unsupportedClaims: [CLAIM] }, withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      await recheck.svc.review({ ...pii, content: `${content} ${CLAIM}`, recipientTier: 'known' });
      expect(await recheck.svc.review({ ...pii, recipientTier: 'known' })).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] } });
    });

    // A steered hold's approval would show the SIN as sent if approved, to whoever steered it (#2333).
    it('lets a personal-details bounce beat a hold that is only for steering, in either order', async () => {
      const detailBounce: BandReviewDecision = { kind: 'bounce', findings: [{ rule: 'pii-not-authorized', detail: 'x' }] };
      const steered: BandReviewDecision = { kind: 'hold', reason: 'Held', findings: [{ rule: 'steered', detail: 'Held' }] };
      // The drafter sees only the details; the steering finding rides along for a send that can't
      // be rewritten, which the gateway holds with both.
      const expected = { ...detailBounce, heldBeside: steered.findings };
      expect(bandReviewModule.combine(detailBounce, steered)).toEqual(expected);
      expect(bandReviewModule.combine(steered, detailBounce)).toEqual(expected);
      // Merging with another bounce keeps it.
      const claimBounce: BandReviewDecision = { kind: 'bounce', findings: [{ rule: 'ungrounded-claim', detail: 'y' }] };
      expect(bandReviewModule.combine(expected, claimBounce)).toMatchObject({ heldBeside: steered.findings });
      // Steering beside speaking for the principal still rewrites first, carrying both.
      const speaking: BandReviewDecision = {
        kind: 'hold', reason: 'Held',
        findings: [{ rule: 'steered', detail: 'Held' }, { rule: 'speaks-as-principal', detail: 'Held' }],
      };
      expect(bandReviewModule.combine(detailBounce, speaking)).toEqual({ ...detailBounce, heldBeside: speaking.findings });
      // Any other reason in the hold keeps it the stricter outcome, steering or not.
      const mixed: BandReviewDecision = {
        kind: 'hold', reason: 'Held',
        findings: [{ rule: 'steered', detail: 'Held' }, { rule: 'review-unavailable', detail: 'Held' }],
      };
      expect(bandReviewModule.combine(detailBounce, mixed)).toBe(mixed);
      expect(bandReviewModule.combine(mixed, detailBounce)).toBe(mixed);
      const speaksAlone: BandReviewDecision = { kind: 'hold', reason: 'Held', findings: [{ rule: 'speaks-as-principal', detail: 'Held' }] };
      expect(bandReviewModule.combine(detailBounce, speaksAlone)).toBe(speaksAlone);
      // A block outranks any hold and carries its reasons, in either order and through a block merge.
      const block: BandReviewDecision = { kind: 'block', reason: 'Not sent', findings: [{ rule: 'pii-not-authorized', detail: 'x' }] };
      const blocked = { ...block, heldBeside: steered.findings };
      expect(bandReviewModule.combine(block, steered)).toEqual(blocked);
      expect(bandReviewModule.combine(steered, block)).toEqual(blocked);
      expect(bandReviewModule.combine(blocked, { ...block })).toMatchObject({ kind: 'block', heldBeside: steered.findings });
      const unreviewed: BandReviewDecision = { kind: 'hold', reason: 'Held', findings: [{ rule: 'review-unavailable', detail: 'Held' }] };
      expect(bandReviewModule.combine(detailBounce, unreviewed)).toBe(unreviewed);
    });

    it('bounces a steered send of an unsupported SIN to a stranger instead of holding it, and holds the clean recheck', async () => {
      const { svc } = make(
        [{ ...withRulings(ruling('unsupported')), purpose: 'steered' }, { ...withRulings(), purpose: 'steered' }],
        { evidence: { authority: fromOutsider } },
      );
      const first = await svc.review(pii);
      expect(first.kind).toBe('bounce');
      if (first.kind === 'bounce') expect(first.findings.map((f) => f.rule)).toContain('pii-not-authorized');
      // The rewrite has no SIN and is still steered: held as before, with nothing to show.
      const recheck = await svc.review({ ...pii, content: 'Hi, I cannot act on a forwarded request.', detectedItems: [] });
      expect(recheck).toMatchObject({ kind: 'hold', findings: [{ rule: 'steered' }] });
    });

    // At 80+ a rewrite that still has the SIN is blocked; the steering reason rides along (#2333).
    it('keeps the steering reason on the block when a steered rewrite still has the SIN at 84', async () => {
      const steeredSin = { ...withRulings(ruling('unsupported')), purpose: 'steered' as const };
      const { svc } = make([steeredSin, steeredSin], { evidence: { authority: fromOutsider } });
      expect((await svc.review(pii)).kind).toBe('bounce');
      const recheck = await svc.review(pii);
      expect(recheck.kind).toBe('block');
      if (recheck.kind === 'block') {
        expect(recheck.findings.map((f) => f.rule)).not.toContain('steered');
        expect(recheck.heldBeside?.map((f) => f.rule)).toEqual(['steered']);
      }
    });

    // A steered verdict that also speaks for the principal below 80 keeps both reasons (#2333).
    it('keeps the speaks-as-principal reason beside steering below 80, through the bounce and the recheck', async () => {
      const both = { purpose: 'steered' as const, speaksAsPrincipal: true };
      const { svc } = make(
        [{ ...withRulings(ruling('unsupported')), ...both }, { ...withRulings(), ...both }],
        { evidence: { authority: fromOutsider } },
      );
      const first = await svc.review({ ...pii, score: 74 });
      expect(first.kind).toBe('bounce');
      if (first.kind === 'bounce') expect(first.heldBeside?.map((f) => f.rule)).toEqual(['steered', 'speaks-as-principal']);
      const recheck = await svc.review({ ...pii, score: 74, content: 'Hi, I cannot act on a forwarded request.', detectedItems: [] });
      expect(recheck.kind).toBe('hold');
      if (recheck.kind === 'hold') expect(recheck.findings.map((f) => f.rule)).toEqual(['steered', 'speaks-as-principal']);
    });

    it('counts the bound or root task\'s principal only with a ruling that names it: an outsider\'s turn under a principal root still bounces unsupported', async () => {
      const outsiderUnderRoot: SendAuthority = {
        originator: outsider, liveTurn: false,
        rootTask: { taskId: 't-root', title: 'Set up the clinic', description: null, originator: principal },
      };
      const { svc } = make([withRulings(ruling('unsupported'))], { evidence: { authority: outsiderUnderRoot } });
      expect((await svc.review(pii)).kind).toBe('bounce');
    });

    it('leaves detected items to the disclosure ruling: a matching unneeded-disclosure quote is dropped', async () => {
      const PHONE = '415-555-0100';
      const phone: BriefDetectedItem = { id: 'P1', label: 'phone_us', text: PHONE, field: 'body' };
      const input = { ...base, content: `Hi Joel. Call Sam on ${PHONE} to book.`, detectedItems: [phone] };
      for (const quote of [PHONE, `Call Sam on ${PHONE}`, '555-0100']) {
        const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: [quote] }], { evidence: { authority: standing } });
        await expect(svc.review(input)).resolves.toEqual({ kind: 'send', signals: {} });
      }
      // Case-insensitive.
      const email: BriefDetectedItem = { id: 'P1', label: 'email', text: 'sam@example.com', field: 'body' };
      const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: ['Sam@Example.com'] }], { evidence: { authority: standing } });
      expect((await svc.review({ ...base, content: 'Hi Joel. Write to Sam@Example.com.', detectedItems: [email] })).kind).toBe('send');
    });

    it('keeps an unneeded-disclosure finding that does not touch a detected item', async () => {
      const { svc } = make([{ ...withRulings(ruling('inferred')), unnecessaryItems: ['His salary is 200k.'] }], { evidence: { authority: standing } });
      const d = await svc.review({ ...pii, content: `${content} His salary is 200k.` });
      expect(d.kind).toBe('bounce');
      if (d.kind === 'bounce') expect(d.findings.map((f) => f.rule)).toEqual(['unneeded-disclosure']);
    });

    it('never quotes a detected item\'s text in any finding or reason', async () => {
      const text = `${content} His salary is 200k.`;
      const flagged: BriefVerdict = {
        ...withRulings(ruling('unsupported')),
        unsupportedClaims: [`Sam's SIN is ${SIN}.`],
        unnecessaryItems: ['His salary is 200k.', `SIN is ${SIN}. His salary`],
      };
      const decisions: BandReviewDecision[] = [];
      for (const score of [84, 74]) {
        const { svc } = make([flagged, flagged], { evidence: { authority: fromOutsider } });
        decisions.push(await svc.review({ ...pii, content: text, score }));
        decisions.push(await svc.review({ ...pii, content: text, score }));
      }
      for (const score of [84, 74]) {
        const failing = make([{ ok: false, failure: 'unreachable' }, { ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
        decisions.push(await failing.svc.review({ ...pii, score }));
        decisions.push(await failing.svc.review({ ...pii, score }));
      }
      const asked = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
      decisions.push(await asked.svc.review({ ...pii, recipientTier: 'known' }));
      expect(decisions.map((d) => d.kind)).toEqual(['bounce', 'block', 'bounce', 'hold', 'bounce', 'hold', 'hold', 'hold', 'hold']);
      for (const d of decisions) expect(JSON.stringify(d)).not.toContain(SIN);
      // The claim still stands, in general terms.
      const first = decisions[0]!;
      if (first.kind === 'bounce') expect(first.findings.map((f) => f.rule)).toEqual(['ungrounded-claim', 'unneeded-disclosure', 'pii-not-authorized']);
    });

    it('holds a recheck that fails again after a PII-failure bounce, naming personal details', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }, { ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      expect((await svc.review(pii)).kind).toBe('bounce');
      // The rewrite dropped the item; the reviewer is still down.
      const d = await svc.review({ ...base, content: 'Hi Joel.' });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        expect(d.reason).toContain('personal details');
        expect(d.reason).not.toContain('unverified statements');
      }
    });

    it('keeps the unverified-statements reason for a recheck after a claim bounce', async () => {
      const { svc } = make([{ ...clean, unsupportedClaims: [CLAIM] }, { ok: false, failure: 'unreachable' }]);
      await svc.review(base);
      const d = await svc.review(base);
      if (d.kind === 'hold') expect(d.reason).toContain('unverified statements');
      expect(d.kind).toBe('hold');
    });

    it('names the personal data, by label, on a judge-failure hold below 80', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }], { evidence: { authority: live } });
      const d = await svc.review({ ...pii, score: 74 });
      expect(d.kind).toBe('hold');
      if (d.kind === 'hold') {
        const finding = d.findings.find((f) => f.rule === 'pii-not-authorized');
        expect(finding?.detail).toContain('sin_ca');
        expect(JSON.stringify(d)).not.toContain(SIN);
      }
    });

    it('treats a ruling list of the right length with a wrong id as malformed', async () => {
      const { svc } = make([withRulings(ruling('directed'), ruling('directed', false, 'P3')), withRulings(ruling('directed'), ruling('directed', false, 'P3'))], { evidence: { authority: live } });
      const input = { ...pii, detectedItems: [P1, P2] };
      expect((await svc.review(input)).kind).toBe('bounce');
      expect((await svc.review(input)).kind).toBe('hold');
    });

    // PR 5 (#2312): a hold that only waits on the principal's yes for a requester's data is an
    // ask, and a cold stranger's request is noted for the digest instead.
    describe('asking the principal', () => {
      const linked = (strength: 'strong' | 'weak'): SendAuthority => ({
        originator: outsider, liveTurn: false,
        linkedTask: {
          taskId: 't-link', title: 'Book physio', originator: principal, linkKind: strength === 'strong' ? 'org-domain' : 'inferred', strength,
          counterparty: { addresses: ['joel@example.com'], contactIds: [], domains: [] },
        },
      });

      it('marks a known requester\'s unsupported request as an ask, naming the primary non-principal recipient', async () => {
        const { svc } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, recipients: ['principal@example.com', 'joel@example.com'], principalRecipients: ['principal@example.com'], recipientTier: 'known' });
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'], requester: 'joel@example.com' } });
        if (d.kind === 'hold') expect(d.ask).not.toHaveProperty('taskTitle');
      });

      it('does not name the task on a weak link\'s ask: the principal\'s authority is not that task\'s', async () => {
        const { svc } = make([withRulings(ruling('inferred', true))], { evidence: { authority: linked('weak') } });
        const d = await svc.review(pii);
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'], requester: 'joel@example.com' } });
        if (d.kind === 'hold') expect(d.ask).not.toHaveProperty('taskTitle');
      });

      it('names the task only when the principal\'s authority comes from it', async () => {
        // A known requester's unsupported request under the principal's bound task: the authority
        // is the task's, so the ask names it.
        const bound: SendAuthority = { ...fromOutsider, boundTask: { taskId: 't', title: 'Book the call', description: null, originator: principal } };
        const under = make([withRulings(ruling('unsupported', true))], { evidence: { authority: bound } });
        expect(await under.svc.review({ ...pii, recipientTier: 'known' })).toMatchObject({ kind: 'hold', ask: { taskTitle: 'Book the call' } });
        // The same request under a task Curia set: an ask, with no title.
        const curiaTask: SendAuthority = { ...fromOutsider, boundTask: { taskId: 't', title: 'Book the call', description: null, originator: curia } };
        const other = make([withRulings(ruling('unsupported', true))], { evidence: { authority: curiaTask } });
        const d = await other.svc.review({ ...pii, recipientTier: 'known' });
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] } });
        if (d.kind === 'hold') expect(d.ask).not.toHaveProperty('taskTitle');
      });

      it('asks for a requested item held below 80 under the principal\'s task, with that task\'s title', async () => {
        for (const basis of ['inferred', 'directed'] as const) {
          const { svc } = make([withRulings(ruling(basis, true))], { evidence: { authority: linked('strong') } });
          const d = await svc.review({ ...pii, score: 74 });
          expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'], requester: 'joel@example.com', taskTitle: 'Book physio' } });
        }
        // The principal set the root, not the bound child: the root carries the authority, so it names the ask.
        const rooted = make([withRulings(ruling('inferred', true))], { evidence: { authority: standing } });
        const d = await rooted.svc.review({ ...pii, score: 74, recipientTier: 'known' });
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'], taskTitle: 'Set up the clinic' } });
        // A bound task the principal set names itself, even under a root they also set.
        const both: SendAuthority = { ...standing, boundTask: { ...standing.boundTask!, originator: principal } };
        const bound = make([withRulings(ruling('inferred', true))], { evidence: { authority: both } });
        expect(await bound.svc.review({ ...pii, score: 74, recipientTier: 'known' })).toMatchObject({ kind: 'hold', ask: { taskTitle: 'Book the call' } });
      });

      it('lists each asked label once, across ask reasons', async () => {
        const P3: BriefDetectedItem = { ...P1, id: 'P3', text: '046 454 287' };
        const { svc } = make([withRulings(ruling('unsupported', true), ruling('unsupported', true, 'P2'), ruling('unsupported', true, 'P3'))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, detectedItems: [P1, P2, P3], recipientTier: 'trusted' });
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca', 'phone_us'] } });
      });

      // The principal is asked first either way below 80: the ask survives, so its question names
      // the requester and records the answer, and both reasons are on the hold.
      it('keeps the ask beside a hold for speaking as the principal below 80', async () => {
        const { svc } = make([{ ...withRulings(ruling('unsupported', true)), speaksAsPrincipal: true }], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, score: 74, recipientTier: 'known' });
        expect(d).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] }, reason: expect.stringContaining('the recipient asked') });
        if (d.kind === 'hold') expect(d.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(['speaks-as-principal', 'pii-not-authorized']));
      });

      it('does not ask when anything but a requester\'s data, or speaking as the principal, holds the send', async () => {
        const cases: Array<{ verdict: BriefVerdict; input: BandReviewInput; authority: SendAuthority }> = [
          // A steered hold beside the ask.
          { verdict: { ...withRulings(ruling('unsupported', true)), purpose: 'steered' }, input: { ...pii, recipientTier: 'known' }, authority: fromOutsider },
          // A second item held below 80 that nobody asked for.
          { verdict: withRulings(ruling('inferred', true), ruling('inferred', false, 'P2')), input: { ...pii, score: 74, detectedItems: [P1, P2] }, authority: linked('strong') },
          // Held below 80 under the principal's task, but not requested.
          { verdict: withRulings(ruling('inferred')), input: { ...pii, score: 74 }, authority: linked('strong') },
          // Held below 80 under the principal's own turn: nobody is asking.
          { verdict: withRulings(ruling('inferred', true)), input: { ...pii, score: 74, recipientTier: 'known' }, authority: { originator: principal, liveTurn: false } },
          // A non-PII hold.
          { verdict: { ...clean, purpose: 'steered' }, input: base, authority: fromOutsider },
        ];
        for (const { verdict, input, authority } of cases) {
          const { svc } = make([verdict], { evidence: { authority } });
          const d = await svc.review(input);
          expect(d.kind).toBe('hold');
          expect(d).not.toHaveProperty('ask');
        }
      });

      it('does not ask on a judge-failure hold', async () => {
        const { svc } = make([{ ok: false, failure: 'unreachable' }], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, score: 74, recipientTier: 'known' });
        expect(d.kind).toBe('hold');
        expect(d).not.toHaveProperty('ask');
      });

      it('names every non-principal recipient, normalized, as the ask\'s counterparties', async () => {
        const { svc } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({
          ...pii, recipients: ['principal@example.com', 'Joel <Joel@Example.com>', 'ops@example.com'],
          principalRecipients: ['principal@example.com'], recipientTiers: { 'joel@example.com': 'known', 'ops@example.com': 'trusted' },
        });
        expect(d).toMatchObject({ kind: 'hold', ask: { counterparties: ['joel@example.com', 'ops@example.com'] } });
        if (d.kind === 'hold') expect(d.ask).not.toHaveProperty('outreachId');
      });

      // Every non-principal recipient must be askable; anyone else makes it a stranger's request.
      it('asks only when every non-principal recipient is askable, by tier or a covering link', async () => {
        const two = { ...pii, recipients: ['joel@example.com', 'ops@other.example'] };
        // One known, one with no contact: a stranger's request, noted on the bounce.
        const mixed = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        expect(await mixed.svc.review({ ...two, recipientTiers: { 'joel@example.com': 'known' } }))
          .toMatchObject({ kind: 'bounce', strangerRequest: { labels: ['sin_ca'], requester: 'joel@example.com' } });
        // The primary's tier alone does not speak for a second recipient.
        const primaryOnly = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        expect((await primaryOnly.svc.review({ ...two, recipientTier: 'known' })).kind).toBe('bounce');
        // One known by tier, the other covered by a link to the principal's task: an ask.
        const viaLink = make([withRulings(ruling('inferred', true))], {
          evidence: { authority: { ...linked('weak'), linkedTask: { ...linked('weak').linkedTask!, counterparty: { addresses: ['ops@other.example'], contactIds: [], domains: [] } } } },
        });
        expect(await viaLink.svc.review({ ...two, recipientTiers: { 'joel@example.com': 'known' } }))
          .toMatchObject({ kind: 'hold', ask: { requester: 'joel@example.com', counterparties: ['joel@example.com', 'ops@other.example'] } });
      });

      it('carries the linked outreach row only when a strong link covers the recipients', async () => {
        const covered = make([withRulings(ruling('inferred', true))], { evidence: { authority: linked('strong'), linkedOutreachId: 'o-1' } });
        expect(await covered.svc.review({ ...pii, score: 74 })).toMatchObject({ kind: 'hold', ask: { outreachId: 'o-1' } });
        // A weak link still asks, but the principal is shown no task, so a yes learns no row.
        const weak = make([withRulings(ruling('inferred', true))], { evidence: { authority: linked('weak'), linkedOutreachId: 'o-1' } });
        const w = await weak.svc.review(pii);
        expect(w.kind).toBe('hold');
        if (w.kind === 'hold') {
          expect(w.ask).toBeDefined();
          expect(w.ask).not.toHaveProperty('outreachId');
        }
        const elsewhere = make([withRulings(ruling('unsupported', true))], { evidence: { authority: linked('weak'), linkedOutreachId: 'o-1' } });
        const d = await elsewhere.svc.review({ ...pii, recipients: ['sam@other.example'], recipientTier: 'known' });
        expect(d.kind).toBe('hold');
        if (d.kind === 'hold') {
          expect(d.ask).toBeDefined();
          expect(d.ask).not.toHaveProperty('outreachId');
        }
      });

      it('writes the task title on one line, without double quotes, and at most 80 characters', async () => {
        const titled = (title: string): SendAuthority => ({
          ...linked('strong'), linkedTask: { ...linked('strong').linkedTask!, title },
        });
        const one = make([withRulings(ruling('inferred', true))], { evidence: { authority: titled('Book\n  physio\tfor "Sam"\r\n') } });
        expect(await one.svc.review({ ...pii, score: 74 })).toMatchObject({ ask: { taskTitle: 'Book physio for \'Sam\'' } });
        const long = make([withRulings(ruling('inferred', true))], { evidence: { authority: titled(`Book ${'x'.repeat(200)}`) } });
        const d = await long.svc.review({ ...pii, score: 74 });
        if (d.kind !== 'hold') throw new Error('expected a hold');
        expect(d.ask!.taskTitle!.length).toBe(80);
        expect(d.ask!.taskTitle!.endsWith('…')).toBe(true);
      });

      it('notes a cold stranger\'s request on the bounce, by label only', async () => {
        const { svc } = make([withRulings(ruling('unsupported', true), ruling('unsupported', false, 'P2'))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, detectedItems: [P1, P2], recipientTier: 'unknown' });
        expect(d).toMatchObject({ kind: 'bounce', strangerRequest: { labels: ['sin_ca'], requester: 'joel@example.com' } });
        expect(JSON.stringify(d)).not.toContain(SIN);
      });

      it('notes nothing for a bounce no stranger asked for, or for the recheck', async () => {
        const unasked = make([withRulings(ruling('unsupported'))], { evidence: { authority: fromOutsider } });
        expect(await unasked.svc.review(pii)).not.toHaveProperty('strangerRequest');
        const asked = make([withRulings(ruling('unsupported', true)), withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        expect(await asked.svc.review(pii)).toHaveProperty('strangerRequest');
        const recheck = await asked.svc.review(pii);
        expect(recheck.kind).toBe('block');
        expect(recheck).not.toHaveProperty('strangerRequest');
      });
    });

    // A quoted message's items (#2312) never decide the outcome: alone they drop the quote.
    describe('items in the quoted message', () => {
      const Q: BriefDetectedItem = { id: 'P2', label: 'phone_us', text: '415-555-0100', field: 'quote' };
      const quoteOnly: BandReviewInput = { ...base, detectedItems: [{ ...Q, id: 'P1' }] };

      it('sends without the quote when only the quote\'s items are unauthorized, and asks about them', async () => {
        const { svc, review } = make([withRulings(ruling('unsupported'))], { evidence: { authority: fromOutsider } });
        const d = await svc.review(quoteOnly);
        expect(d).toEqual({ kind: 'send', signals: {}, dropQuote: { labels: ['phone_us'] } });
        expect(review.mock.calls[0]![0].detectedItems).toEqual(quoteOnly.detectedItems);
        // A send clears the ledger: the next draft is not a recheck.
        const next = make([withRulings(ruling('unsupported'))], { evidence: { authority: fromOutsider } });
        expect((await next.svc.review(quoteOnly)).kind).toBe('send');
      });

      it('drops the quote instead of asking, even when the recipient asked for it', async () => {
        const { svc } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...quoteOnly, recipientTier: 'trusted' });
        expect(d).toMatchObject({ kind: 'send', dropQuote: { labels: ['phone_us'] } });
      });

      it('keeps the quote when its items are authorized', async () => {
        const { svc } = make([withRulings(ruling('directed'))], { evidence: { authority: live } });
        const d = await svc.review(quoteOnly);
        expect(d).toEqual({ kind: 'send', signals: {} });
      });

      it('lets the body decide when the body also has a problem', async () => {
        const { svc } = make([withRulings(ruling('unsupported'), ruling('unsupported', false, 'P2'))], { evidence: { authority: fromOutsider } });
        const d = await svc.review({ ...pii, detectedItems: [P1, Q] });
        expect(d.kind).toBe('bounce');
        if (d.kind === 'bounce') {
          // The body's label only: the rewrite's own review rules on the quote again.
          expect(d.findings.map((f) => f.detail).join(' ')).toContain('sin_ca');
          expect(d.findings.map((f) => f.detail).join(' ')).not.toContain('phone_us');
        }
      });

      it('lets another finding decide too', async () => {
        const { svc } = make([{ ...withRulings(ruling('unsupported')), purpose: 'steered' }], { evidence: { authority: fromOutsider } });
        const d = await svc.review(quoteOnly);
        expect(d.kind).toBe('hold');
        expect(d).not.toHaveProperty('dropQuote');
      });

      it('sends an authorized body item with the quote dropped', async () => {
        const { svc } = make([withRulings(ruling('directed'), ruling('unsupported', false, 'P2'))], { evidence: { authority: live } });
        expect(await svc.review({ ...pii, detectedItems: [P1, Q] })).toEqual({ kind: 'send', signals: {}, dropQuote: { labels: ['phone_us'] } });
      });

      it('drops an unreviewed quote on a fail-open send, and ignores it on a hold', async () => {
        // A fail-open send is principal-directed (#2473); any other send holds unrated.
        const at84 = make([{ ok: false, failure: 'unreachable' }]);
        expect(await at84.svc.review({ ...quoteOnly, principalDirected: true })).toMatchObject({ kind: 'send', report: { source: 'sent_without_review' }, dropQuote: { labels: ['phone_us'] } });
        const withBody = make([{ ok: false, failure: 'unreachable' }]);
        const d = await withBody.svc.review({ ...pii, detectedItems: [P1, Q] });
        expect(d.kind).toBe('bounce');
        if (d.kind === 'bounce') expect(d.findings.map((f) => f.detail).join(' ')).not.toContain('phone_us');
      });

      it('asks only about the message\'s own items when a long quote passes the cap', async () => {
        const quoted = Array.from({ length: 10 }, (_, i): BriefDetectedItem => ({ ...Q, id: `P${i + 2}` }));
        const { svc, review } = make([withRulings(ruling('directed'))], { evidence: { authority: live } });
        const d = await svc.review({ ...pii, detectedItems: [P1, ...quoted] });
        expect(review.mock.calls[0]![0].detectedItems).toEqual([P1]);
        expect(d).toMatchObject({ kind: 'send', dropQuote: { labels: ['phone_us'] } });
      });
    });
  });

  // PR 5 (#2312): the principal's recorded yes or no on this thread decides, for exactly that
  // label and recipient. Review Focus 1 and 2.
  describe('the principal\'s earlier answer on this thread', () => {
    const PHONE = '415-555-0100';
    const SIN = '046 454 286';
    const P_PHONE: BriefDetectedItem = { id: 'P1', label: 'phone_us', text: PHONE, field: 'body' };
    const P_SIN: BriefDetectedItem = { id: 'P2', label: 'sin_ca', text: SIN, field: 'body' };
    const TO = 'bookings@acme.example';
    const send: BandReviewInput = {
      ...base, conversationId: 'conv-T', recipients: [TO], recipientTier: 'known',
      content: `Hi. The number is ${PHONE}.`, detectedItems: [P_PHONE],
    };
    const outsider: NonNullable<SendAuthority['originator']> = { contactId: TO, systemRole: null, tier: 'known', channel: 'email', authenticated: true };
    const fromRequester: SendAuthority = { originator: outsider, liveTurn: false };
    const ruling = (basis: DisclosureRuling['basis'], requested: boolean, id = 'P1'): DisclosureRuling => ({ id, basis, requested, reason: 'x' });
    type OkVerdict = Extract<BriefVerdict, { ok: true }>;
    const withRulings = (...disclosures: DisclosureRuling[]): OkVerdict => ({ ...(clean as OkVerdict), disclosures });
    const said = (decision: 'yes' | 'no', label = 'phone_us', counterparty = TO) => ({ counterparty, label, decision });
    const DECLINED = 'The principal declined sharing the principal\'s phone number with this recipient on this thread. Rewrite without it.';

    it('reads decisions for the send\'s thread and non-principal recipients', async () => {
      const { svc, collect } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester } });
      await svc.review({ ...send, recipients: ['principal@example.com', TO], principalRecipients: ['principal@example.com'] });
      expect(collect).toHaveBeenCalledWith(['task-1'], { conversationId: 'conv-T', counterparties: [TO] });
    });

    it('sends a label the principal said yes to for this recipient, whatever the judge\'s basis', async () => {
      for (const r of [ruling('unsupported', true), ruling('unsupported', false), ruling('inferred', false)]) {
        for (const score of [84, 74]) {
          const { svc } = make([withRulings(r)], { evidence: { authority: fromRequester, decisions: [said('yes')] } });
          expect((await svc.review({ ...send, score })).kind).toBe('send');
        }
      }
    });

    it('does not let a yes for one label, or one recipient, authorize another', async () => {
      // Another label: sin_ca was never answered, so it is asked about as before.
      const other = make([withRulings(ruling('unsupported', true, 'P2'))], { evidence: { authority: fromRequester, decisions: [said('yes')] } });
      const d1 = await other.svc.review({ ...send, content: `SIN ${SIN}`, detectedItems: [P_SIN] });
      expect(d1).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] } });
      // Both labels: the yes covers phone_us only, so the send still waits on sin_ca.
      const both = make([withRulings(ruling('unsupported', true), ruling('unsupported', true, 'P2'))], { evidence: { authority: fromRequester, decisions: [said('yes')] } });
      expect(await both.svc.review({ ...send, detectedItems: [P_PHONE, P_SIN] })).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] } });
      // Another counterparty: a yes recorded for someone else is not this recipient's.
      const elsewhere = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes', 'phone_us', 'other@acme.example')] } });
      expect(await elsewhere.svc.review(send)).toMatchObject({ kind: 'hold', ask: { labels: ['phone_us'] } });
      // A second recipient without a yes of their own.
      const two = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes')] } });
      expect(await two.svc.review({ ...send, recipients: [TO, 'ops@acme.example'], recipientTiers: { [TO]: 'known', 'ops@acme.example': 'known' } }))
        .toMatchObject({ kind: 'hold', ask: { labels: ['phone_us'] } });
    });

    it('bounces a label the principal declined for this recipient, never asking again', async () => {
      const { svc, review } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('no')] } });
      const d = await svc.review(send);
      expect(d).toEqual({ kind: 'bounce', findings: [{ rule: 'pii-not-authorized', detail: DECLINED }] });
      // The judge is told, without the recipient's identifier.
      const evidence = review.mock.calls[0]![0].evidence;
      expect(evidence.principalDecisions).toEqual(['The principal already said no to sharing phone number with this recipient on this thread.']);
      expect(evidence).not.toHaveProperty('decisions');
      expect(JSON.stringify(evidence.principalDecisions)).not.toContain(TO);
    });

    it('bounces on a no for any recipient, even with a yes for another, and still asks about a different label', async () => {
      const mixed = make([withRulings(ruling('unsupported', true))], {
        evidence: { authority: fromRequester, decisions: [said('yes'), said('no', 'phone_us', 'ops@acme.example')] },
      });
      expect(await mixed.svc.review({ ...send, recipients: [TO, 'ops@acme.example'] })).toMatchObject({ kind: 'bounce', findings: [{ detail: DECLINED }] });
      const otherLabel = make([withRulings(ruling('unsupported', true, 'P2'))], { evidence: { authority: fromRequester, decisions: [said('no')] } });
      expect(await otherLabel.svc.review({ ...send, content: `SIN ${SIN}`, detectedItems: [P_SIN] })).toMatchObject({ kind: 'hold', ask: { labels: ['sin_ca'] } });
    });

    it('after a declined label\'s one rewrite, blocks at 84 and holds at 74 without an ask', async () => {
      const at84 = make([withRulings(ruling('unsupported', true)), withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('no')] } });
      await at84.svc.review(send);
      expect((await at84.svc.review(send)).kind).toBe('block');
      const at74 = make([withRulings(ruling('unsupported', true)), withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('no')] } });
      await at74.svc.review({ ...send, score: 74 });
      const d = await at74.svc.review({ ...send, score: 74 });
      expect(d.kind).toBe('hold');
      expect(d).not.toHaveProperty('ask');
    });

    it('lets the principal\'s own live directive send a label they declined earlier', async () => {
      const principal: NonNullable<SendAuthority['originator']> = { contactId: 'c-p', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true };
      const { svc } = make([withRulings(ruling('directed', false))], { evidence: { authority: { originator: principal, liveTurn: true }, decisions: [said('no')] } });
      expect((await svc.review(send)).kind).toBe('send');
    });

    it('tells the judge about a yes, too, as a sentence', async () => {
      const { svc, review } = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes'), said('yes', 'sin_ca')] } });
      await svc.review(send);
      expect(review.mock.calls[0]![0].evidence.principalDecisions).toEqual([
        'The principal already said yes to sharing phone number with this recipient on this thread.',
        'The principal already said yes to sharing SIN with this recipient on this thread.',
      ]);
    });

    it('tells the judge only what holds for every recipient: one recipient\'s answer is partial', async () => {
      const OPS = 'ops@acme.example';
      const PARTIAL = 'The principal answered about sharing phone number for some of the recipients only, on this thread.';
      // A yes for one of two recipients is not a yes for the send.
      const partial = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes')] } });
      await partial.svc.review({ ...send, recipients: [TO, OPS] });
      expect(partial.review.mock.calls[0]![0].evidence.principalDecisions).toEqual([PARTIAL]);
      // A yes and a no: code bounces on any no, so the judge reads a no, once.
      const mixed = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes'), said('no', 'phone_us', OPS)] } });
      await mixed.svc.review({ ...send, recipients: [TO, OPS] });
      expect(mixed.review.mock.calls[0]![0].evidence.principalDecisions).toEqual(['The principal already said no to sharing phone number with this recipient on this thread.']);
      // A yes from both: a yes, once.
      const both = make([withRulings(ruling('unsupported', true))], { evidence: { authority: fromRequester, decisions: [said('yes'), said('yes', 'phone_us', OPS)] } });
      await both.svc.review({ ...send, recipients: [TO, OPS] });
      expect(both.review.mock.calls[0]![0].evidence.principalDecisions).toEqual(['The principal already said yes to sharing phone number with this recipient on this thread.']);
      for (const h of [partial, mixed, both]) expect(JSON.stringify(h.review.mock.calls[0]![0].evidence.principalDecisions)).not.toMatch(/acme\.example/);
    });
  });

  describe('describePiiLabels', () => {
    it('uses human labels, once each, joined with "and"', () => {
      expect(bandReviewModule.describePiiLabels(['phone_us'])).toBe('phone number');
      expect(bandReviewModule.describePiiLabels(['phone_us', 'sin_ca'])).toBe('phone number and SIN');
      expect(bandReviewModule.describePiiLabels(['phone_uk_mobile', 'email', 'credit_card', 'ssn', 'extra_0', 'extra_3'])).toBe('mobile number and email address and card number and SSN and personal detail');
    });
  });

  describe('redaction placeholders', () => {
    const DETAIL = 'This message contains a redaction placeholder. Rewrite it with the real content or without that part.';
    const tokened: BandReviewInput = { ...base, content: 'Hi Joel. Call Sam on [REDACTED: PHONE_US].' };

    it('bounces a placeholder, then blocks it at 84', async () => {
      const { svc } = make([clean, clean]);
      const first = await svc.review(tokened);
      expect(first).toEqual({ kind: 'bounce', findings: [{ rule: 'redaction-token', detail: DETAIL }] });
      const second = await svc.review(tokened);
      expect(second.kind).toBe('block');
      if (second.kind === 'block') expect(second.findings).toEqual([{ rule: 'redaction-token', detail: DETAIL }]);
    });

    it('holds the second placeholder at 74', async () => {
      const { svc } = make([clean, clean]);
      await svc.review({ ...tokened, score: 74 });
      expect((await svc.review({ ...tokened, score: 74 })).kind).toBe('hold');
    });

    it('bounces a placeholder even when the judge fails at 84', async () => {
      const { svc } = make([{ ok: false, failure: 'unreachable' }]);
      expect((await svc.review(tokened)).kind).toBe('bounce');
    });

    it('catches a placeholder in the subject alone', async () => {
      const { svc } = make([clean]);
      const d = await svc.review({ ...base, subject: 'Re: [REDACTED: EMAIL]' });
      expect(d).toEqual({ kind: 'bounce', findings: [{ rule: 'redaction-token', detail: DETAIL }] });
    });

    it('ignores bracketed text that is not a placeholder', async () => {
      const { svc } = make([clean]);
      expect((await svc.review({ ...base, content: 'Hi Joel. [REDACTED] and [redacted: x] are fine.' })).kind).toBe('send');
    });
  });
});
