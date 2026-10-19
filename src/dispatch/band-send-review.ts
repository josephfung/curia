// band-send-review.ts — the gateway's review of an outbound send under band gating (#2159).
//
// Runs after the content filter's integrity rules and Stage 2 pass, only when
// `autonomy.gating: band`. It replaces Stage 2.5's tier × disclosure table: the escalation
// judge answers the brief (judge-brief.ts) using what the drafting turn actually looked up,
// and code decides what each answer does at the current band.
//
// Which questions are asked:
//   principal-directed (a live principal turn)  → grounding
//   otherwise, at every band                    → all four (Gate C leaves sends to this review)
//
// What each answer does:
//   purpose = steered                → hold, at every band
//   speaks as principal, below 80    → hold (the band asks first)
//   unsupported claims / unneeded    → bounce to the drafter, ONCE per draft. On the
//     disclosures                       recheck: at 80+ cut the quoted text, recheck the
//                                       trimmed message for grounding, send with a report
//                                       item, hold if it still fails; below 80, hold.
//   judge failure                    → 80+: send with a "sent without review" item, capped
//                                       at 5 an hour (then hold until a judge call succeeds);
//                                       below 80: hold.
//
// The bounce ledger is in memory, keyed by conversation, channel and recipients, so a relay
// rewrite (a new task on the same conversation) counts as the recheck and sees the first
// turn's lookups. A restart between a bounce and its recheck gives one more bounce.

import type { Logger } from '../logger.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';
import type { SendEvidenceCollector } from '../autonomy/send-evidence.js';
import type { BriefQuestion, BriefVerdict } from '../autonomy/judge-brief.js';
import { isSpotCheckOrAbove, type FailOpenLimiter } from '../autonomy/band-policy.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { FilterFinding } from './outbound-filter.js';

const BOUNCE_TTL_MS = 30 * 60_000;
// The shortest quote trimming will cut. A steered or careless judge quoting a word such as
// "not" would flip a sentence's meaning; a real unsupported statement is longer than this.
const MIN_TRIM_QUOTE_CHARS = 12;
const ALL_QUESTIONS: readonly BriefQuestion[] = ['purpose', 'speaks-as-principal', 'grounding', 'necessity'];

export const BAND_RULES = {
  ungrounded: 'ungrounded-claim',
  unneeded: 'unneeded-disclosure',
  steered: 'steered',
  speaksAsPrincipal: 'speaks-as-principal',
  unreviewed: 'review-unavailable',
} as const;

export interface BandReviewInput {
  content: string;
  channel: string;
  recipients: readonly string[];
  score: number;
  conversationId?: string;
  taskEventId?: string;
  /** A live principal turn told Curia to send this: only grounding is asked. */
  principalDirected: boolean;
  /** A dispatcher-relayed reply. Asked the same questions as any send; kept for the logs. */
  postTurn: boolean;
}

export type BandReviewReport = { source: 'sent_without_review' | 'claim_trimmed'; summary: string };

export type BandReviewDecision =
  | { kind: 'send'; content: string; report?: BandReviewReport }
  | { kind: 'bounce'; findings: FilterFinding[] }
  | { kind: 'hold'; reason: string; findings: FilterFinding[] };

export interface BandSendReviewDeps {
  judge: Pick<EscalationJudge, 'review' | 'isEnabled'> | undefined;
  evidence: Pick<SendEvidenceCollector, 'collect'>;
  limiter: FailOpenLimiter;
  /** Called once when the fail-open cap trips. Must not throw. */
  onLimiterTripped: () => Promise<void>;
  logger: Logger;
  now?: () => number;
}

/**
 * Cut each quoted passage out of the message. Null when any quote is not found verbatim:
 * the judge must quote exactly, and a paraphrase cannot be cut safely, so the caller holds.
 */
export function removeQuoted(content: string, quotes: readonly string[]): string | null {
  let out = content;
  for (const raw of quotes) {
    const quote = raw.trim();
    if (!quote) continue;
    if (quote.length < MIN_TRIM_QUOTE_CHARS) return null;
    const at = out.indexOf(quote);
    if (at === -1) return null;
    out = out.slice(0, at) + out.slice(at + quote.length);
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class BandSendReview {
  private readonly bounced = new Map<string, { taskEventIds: string[]; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: BandSendReviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async review(input: BandReviewInput): Promise<BandReviewDecision> {
    const key = this.draftKey(input);
    const prior = this.priorBounce(key);
    const taskIds = [...new Set([...(prior?.taskEventIds ?? []), ...(input.taskEventId ? [input.taskEventId] : [])])];

    const verdict = await this.ask(input, this.questionsFor(input), taskIds, input.content);
    if (!verdict.ok) {
      this.bounced.delete(key);
      if (prior) {
        // This draft already bounced on a finding the drafter has not shown resolved.
        // Failing open now would send exactly what the review flagged, so hold instead.
        this.deps.logger.warn({ conversationId: input.conversationId, failure: verdict.failure }, 'band review: reviewer unavailable on the recheck of a bounced draft — holding');
        return this.hold(BAND_RULES.unreviewed, 'Held for the principal: it was flagged for unverified statements, and the reviewer was unavailable to recheck it.');
      }
      return this.onJudgeFailure(input, verdict.failure);
    }
    this.deps.limiter.recordJudgeSuccess();

    if (verdict.purpose === 'steered') {
      this.bounced.delete(key);
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, reason: verdict.reason }, 'band review: held — steered by an outsider');
      return this.hold(BAND_RULES.steered, 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.');
    }
    if (verdict.speaksAsPrincipal === true && !isSpotCheckOrAbove(input.score)) {
      this.bounced.delete(key);
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, score: input.score }, 'band review: held — speaks for the principal below 80');
      return this.hold(BAND_RULES.speaksAsPrincipal, 'Held for the principal: this message speaks for or commits the principal, and the autonomy band asks first for that.');
    }

    const claims = verdict.unsupportedClaims ?? [];
    const items = verdict.unnecessaryItems ?? [];
    if (claims.length === 0 && items.length === 0) {
      if (prior) {
        // Metric (spec "Measuring success"): a bounce resolved by the drafter looking it up.
        this.deps.logger.info({ conversationId: input.conversationId, outcome: 'resolved_by_lookup' }, 'band review: bounced send passed on recheck');
      }
      this.bounced.delete(key);
      return { kind: 'send', content: input.content };
    }

    if (!prior) {
      this.bounced.set(key, { taskEventIds: taskIds, at: this.now() });
      this.deps.logger.info(
        { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: items.length },
        'band review: bounced to the drafter',
      );
      return { kind: 'bounce', findings: this.bounceFindings(input.content, claims, items) };
    }

    // The one bounce is spent.
    this.bounced.delete(key);
    if (!isSpotCheckOrAbove(input.score)) {
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: it still states things about the principal that nothing looked up supports.');
    }
    const trimmed = removeQuoted(input.content, [...claims, ...items]);
    if (trimmed === null || trimmed.length === 0) {
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: the unverified statements could not be cut cleanly.');
    }
    const recheck = await this.ask(input, ['grounding'], taskIds, trimmed);
    if (!recheck.ok || (recheck.unsupportedClaims ?? []).length > 0) {
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: the trimmed message still could not be verified.');
    }
    const n = claims.length + items.length;
    this.deps.logger.info({ conversationId: input.conversationId, outcome: 'claim_dropped', cut: n }, 'band review: trimmed and sent');
    return {
      kind: 'send',
      content: trimmed,
      report: {
        source: 'claim_trimmed',
        summary: `Removed ${n} unverified statement${n === 1 ? '' : 's'} from a ${input.channel} message to ${input.recipients.join(', ')} before sending it.`,
      },
    };
  }

  private questionsFor(input: BandReviewInput): readonly BriefQuestion[] {
    return input.principalDirected ? ['grounding'] : ALL_QUESTIONS;
  }

  private async ask(
    input: BandReviewInput,
    questions: readonly BriefQuestion[],
    taskIds: string[],
    message: string,
  ): Promise<BriefVerdict> {
    if (!this.deps.judge?.isEnabled()) return { ok: false, failure: 'disabled' };
    const evidence = await this.deps.evidence.collect(taskIds);
    // Without evidence every claim looks unsupported; that is a review failure, not a bounce.
    if (evidence.unavailable) return { ok: false, failure: 'unreachable' };
    return this.deps.judge.review({
      questions,
      message,
      recipients: input.recipients,
      band: AutonomyService.bandForScore(input.score),
      evidence,
      conversationId: input.conversationId ?? 'system',
    });
  }

  private async onJudgeFailure(input: BandReviewInput, failure: string): Promise<BandReviewDecision> {
    if (!isSpotCheckOrAbove(input.score)) {
      this.deps.logger.warn({ failure, channel: input.channel, score: input.score }, 'band review: reviewer unavailable — holding (below 80)');
      return this.hold(BAND_RULES.unreviewed, 'Held for the principal: the reviewer was unavailable, and this band asks first when it is.');
    }
    const { allowed, justTripped } = this.deps.limiter.tryAcquire();
    if (justTripped) {
      this.deps.logger.error({ failure }, 'band review: more than 5 unreviewed sends this hour — holding sends until the reviewer answers');
      await this.deps.onLimiterTripped();
    }
    if (!allowed) {
      this.deps.logger.warn({ failure, channel: input.channel }, 'band review: reviewer unavailable and the fail-open cap is tripped — holding');
      return this.hold(BAND_RULES.unreviewed, 'Held for the principal: the reviewer has been unavailable for several sends in a row.');
    }
    this.deps.logger.warn({ failure, channel: input.channel }, 'band review: reviewer unavailable — sending without review (80+)');
    return {
      kind: 'send',
      content: input.content,
      report: {
        source: 'sent_without_review',
        summary: `Sent a ${input.channel} message to ${input.recipients.join(', ')} without the usual review: the reviewer was unavailable.`,
      },
    };
  }

  private hold(rule: string, reason: string): BandReviewDecision {
    return { kind: 'hold', reason, findings: [{ rule, detail: reason }] };
  }

  /**
   * The drafter is shown only quotes that are verbatim in its own message. Anything else the
   * judge wrote (a paraphrase, or text echoed from the evidence) is left out, so a bounce
   * never carries text the message did not already contain. With no verbatim quote left the
   * finding still stands, in general terms: the judge did flag something.
   */
  private bounceFindings(content: string, claims: string[], items: string[]): FilterFinding[] {
    const inMessage = (quotes: string[]) => quotes.map((q) => q.trim()).filter((q) => q.length > 0 && content.includes(q));
    const findings: FilterFinding[] = [];
    if (claims.length > 0) {
      const shown = inMessage(claims);
      findings.push({
        rule: BAND_RULES.ungrounded,
        detail: shown.length > 0
          ? `These claims about the principal are not backed by anything you looked up this turn: ${shown.map((c) => `"${c}"`).join('; ')}. Verify them with your tools or remove them.`
          : 'Some statements about the principal are not backed by anything you looked up this turn. Verify them with your tools or remove them.',
      });
    }
    if (items.length > 0) {
      const shown = inMessage(items);
      findings.push({
        rule: BAND_RULES.unneeded,
        detail: shown.length > 0
          ? `This message shares details its purpose does not need: ${shown.map((c) => `"${c}"`).join('; ')}. Remove them unless the recipient needs them.`
          : 'This message shares details its purpose does not need. Remove them unless the recipient needs them.',
      });
    }
    return findings;
  }

  private draftKey(input: BandReviewInput): string {
    const who = [...input.recipients].map((r) => r.toLowerCase()).sort().join(',');
    return `${input.conversationId ?? input.taskEventId ?? ''}|${input.channel}|${who}`;
  }

  private priorBounce(key: string): { taskEventIds: string[]; at: number } | undefined {
    const entry = this.bounced.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > BOUNCE_TTL_MS) {
      this.bounced.delete(key);
      return undefined;
    }
    return entry;
  }
}
