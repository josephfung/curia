// band-send-review.ts — the gateway's review of an outbound send under band gating (#2159).
//
// Runs after the content filter's integrity rules and Stage 2 pass, only when
// `autonomy.gating: band`. It replaces Stage 2.5's tier × disclosure table: the escalation
// judge answers the brief (judge-brief.ts) using what the drafting turn actually looked up,
// and code decides what each answer does at the current band.
//
// Which questions are asked:
//   principal-directed (a live principal turn)  → grounding
//   autonomous, principal's own mailbox (#2474) → purpose, stakes, grounding, necessity, off-thread
//   otherwise, at every band                    → all five (Gate C leaves sends to this review)
//
// What each answer does:
//   purpose = steered                → hold, at every band
//   off-thread (autonomous mailbox)  → hold, at every band and under any stakes ceiling (#2474,
//                                       design D10): an autonomous reply never passes on what
//                                       the thread's messages don't already show. It outranks
//                                       every other outcome and leads the reason; the other
//                                       findings come along. Asked on every autonomous send:
//                                       the gateway's limits require a non-principal recipient,
//                                       which is the only "outside" the gateway knows. "On the
//                                       thread" is only what every recipient received (the
//                                       gateway filters it). A judge failure or a malformed
//                                       answer holds, never bounces, even with personal data.
//   speaks as principal              → by its stakes (#2473): routine sends at 80+, a commitment
//                                       at 90+, financial or legal never; below that, hold. An
//                                       autonomous principal-mailbox send (#2474) always speaks as
//                                       the principal (not asked), and its sending setting's
//                                       stakes ceiling holds any rating above it
//   unsupported claims / unneeded    → bounce to the drafter, ONCE per draft. Curia never
//     disclosures                       cuts text out of a message: the drafter rewrites it.
//                                       If the rewrite still has findings, at 80+ the send is
//                                       refused back to the drafter (not sent, told to rewrite
//                                       again or tell the principal); below 80, held. The
//                                       gateway holds instead of refusing when no drafter is
//                                       waiting: a relayed reply or a saved draft.
//   judge failure                    → hold at every band: the stakes are unrated, so treated
//                                       as financial or legal (fail closed, #2473). The fail-open
//                                       cap is not used. Only a principal-directed send, which
//                                       is not stakes-gated, fails open at 80+: sent with a "sent
//                                       without review" item, capped at 5 an hour (then hold
//                                       until a judge call succeeds); below 80: hold.
//
// Detected personal data (#2312): `disclosure` is added to the questions, and the judge rules
// each item directed / inferred / unsupported and whether the recipient asked. Code decides
// who had the authority to direct it, from trusted state (never the judge's word):
//   principal — the drafting turn's originator, or the bound or root task's, is the principal;
//               so is a strong reply-to-task link to a task the principal directed. Through
//               a task or a link only, a directed ruling counts as inferred.
//   trusted   — the originator was stamped trusted, is trusted now, and authenticated
//   directed  + principal → send          directed + trusted → hold for the principal (any score)
//   inferred  + principal → send at 80+, hold below
//   anything else is unsupported: requested, with every non-principal recipient askable (known
//   or trusted, or covered by a link, strong or weak, to a task the principal directed) → hold
//   (ask the principal); otherwise bounce, then block/hold like any finding. More than 10
//   items, or a judge failure with items present, is never a fail-open send. A link counts for
//   authority only when every non-principal recipient is a counterparty it links: the linked
//   sender, or an address, contact or org domain on the outreach row. A `[REDACTED: …]`
//   placeholder in the content bounces the same way. The strictest outcome of all the rules
//   wins: block > hold > bounce > send, except that a bounce beats an ask, and an ask survives
//   a hold for speaking as the principal below what its stakes need (both reasons show on the approval).
//
// A hold that waits only on the principal's yes to a requester (an askable recipient's request,
// or a requested item held below 80 under the principal's task) carries `ask`: the gateway
// shows the principal a question (naming the task only when the principal's authority is that
// task's) and tells the agent to deliver it now. Any other hold reason beside it drops the ask;
// a bounce beside it wins, so the drafter fixes the other finding and the recheck asks. A cold stranger's request bounces with `strangerRequest`, so the
// digest says Curia did not share it. Both name labels and the requester only, never values.
//
// Items in an email's quoted message (field `quote`) are reached only when someone on the send
// was not on that message; the gateway skips them otherwise. They never decide the outcome: if
// the rest of the send goes out but they would not, it goes out with `dropQuote` and the gateway
// removes the quote. Any other outcome is decided without them.
//
// The principal's answer to an ask is remembered per thread (#2312, disclosure_decisions): a
// latest yes for a label from every non-principal recipient sends that item whatever the judge's
// basis; a latest no from any of them bounces it (then blocks or holds on the recheck like any
// finding) and is never asked again. Only the principal's own live directive overrides a no.
// The judge sees these as sentences about "this recipient", never the recipient's identifier.
//
// The bounce ledger is in memory, keyed by conversation, channel and recipients, so a relay
// rewrite (a new task on the same conversation) counts as the recheck and sees the first
// turn's lookups. A restart between a bounce and its recheck gives one more bounce. The two
// post-bounce fates treat the entry differently: a block (80+) keeps it, so the drafter's next
// dirty attempt blocks again; a hold (below 80) clears it, because the principal now decides
// and a later draft on the same key starts a fresh cycle with its own bounce.

import type { Logger } from '../logger.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';
import { replyTargetEvidence, reportEvidence, threadEvidence, type CollectedEvidence, type SendEvidenceCollector } from '../autonomy/send-evidence.js';
import { describePiiLabels, normalizeCounterparty, type DisclosureDecisionRow } from '../autonomy/disclosure-decisions.js';
import type {
  BriefAnswers, BriefDetectedItem, BriefQuestion, BriefVerdict, DisclosureRuling, SendAuthority, SendStakes,
} from '../autonomy/judge-brief.js';
import type { ContactTier } from '../contacts/types.js';
import { isSpotCheckOrAbove, type FailOpenLimiter } from '../autonomy/band-policy.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { FilterFinding } from './outbound-filter.js';
import { orgDomainsOf } from './task-outreach-capability.js';
import { isUuid } from '../util/uuid.js';

const BOUNCE_TTL_MS = 30 * 60_000;
const ALL_QUESTIONS: readonly BriefQuestion[] = ['purpose', 'speaks-as-principal', 'stakes', 'grounding', 'necessity'];
/**
 * The score a send that speaks for the principal needs to go out without asking, by its stakes
 * (#2473). Null: never, at any band. Routine is the spot-check line (isSpotCheckOrAbove).
 */
const STAKES_MIN_SCORE: Record<SendStakes, number | null> = { routine: 80, commitment: 90, financial_or_legal: null };
/** Orders the stakes ratings for a sending setting's ceiling (#2474). */
const STAKES_RANK: Record<SendStakes, number> = { routine: 0, commitment: 1, financial_or_legal: 2 };
const STAKES_LABEL: Record<SendStakes, string> = { routine: 'routine', commitment: 'commitment', financial_or_legal: 'financial or legal' };
const STAKES_HOLD_LEAD: Record<SendStakes, string> = {
  routine: 'Held for the principal: this message speaks for or commits the principal, and the autonomy band asks first for that.',
  commitment: 'Held for the principal: this message commits the principal, and Curia sends a commitment without asking only at 90 or above.',
  financial_or_legal: 'Held for the principal: this message commits the principal on money or legal terms, which always needs the principal\'s approval.',
};
/** The longest stakes reason shown on an approval; the judge is asked for one short sentence. */
const STAKES_REASON_MAX = 200;
/** The most detected items the judge rules on in one call; past it, none are asked about (#2312). */
const MAX_REVIEWED_ITEMS = 10;
/** A placeholder the tier redactor writes. Under band gating it is a defect, never delivered. */
const REDACTION_TOKEN = /\[REDACTED: [A-Z0-9_]+\]/;
const TOO_MANY_DETAIL = 'This message contains more personal details than can be reviewed at once. Send fewer, or split the message.';
const TOKEN_DETAIL = 'This message contains a redaction placeholder. Rewrite it with the real content or without that part.';
const UNREVIEWED_BELOW_80_REASON = 'Held for the principal: the reviewer was unavailable, and this band asks first when it is.';
const ORIGIN_UNRESOLVED_REASON = 'Held for the principal: the message that started this delegated work could not be read, so the reviewer could not check who it serves.';
/** Scenarios assert "isn't on the thread" (#2474): keep the phrase if this is reworded. */
const OFF_THREAD_REASON = 'Held for the principal: it shares information that isn\'t on the thread, and Curia doesn\'t pass on new information without the principal.';
const STAKES_UNREVIEWED_REASON = 'Held for the principal: the reviewer was unavailable, so what this message commits the principal to is unrated and treated as financial or legal. Stakes: financial or legal (unrated).';

/** What the drafter is told when a send is blocked; the gateway appends the findings. */
export const BLOCK_REASON = 'Not sent: after one rewrite it still has the problems below. Rewrite it again without them, or tell the principal.';

export const BAND_RULES = {
  ungrounded: 'ungrounded-claim',
  unneeded: 'unneeded-disclosure',
  steered: 'steered',
  speaksAsPrincipal: 'speaks-as-principal',
  unreviewed: 'review-unavailable',
  pii: 'pii-not-authorized',
  token: 'redaction-token',
  offThread: 'off-thread',
} as const;

export interface BandReviewInput {
  content: string;
  channel: string;
  recipients: readonly string[];
  /** The subset of `recipients` that are the principal; the judge never treats content to them as a disclosure. */
  principalRecipients?: readonly string[];
  score: number;
  conversationId?: string;
  taskEventId?: string;
  /** A live principal turn told Curia to send this: only grounding is asked. */
  principalDirected: boolean;
  /** A dispatcher-relayed reply. Asked the same questions as any send; kept for the logs. */
  postTurn: boolean;
  /** The note the dispatcher cut from this relayed reply and queued for the principal (#2312); evidence that Curia told them. */
  reportedToPrincipal?: string;
  /** The personal data detected in the send (#2312); each item needs an authorized ruling to go out. */
  detectedItems?: readonly BriefDetectedItem[];
  /** The primary recipient's tier: a known or trusted requester can be asked about (#2312). Used only without `recipientTiers`. */
  recipientTier?: ContactTier;
  /**
   * Every person recipient's tier, by normalized id, when the caller resolved them (#2312). An
   * ask needs every non-principal recipient askable; one missing here is not (no contact, or
   * the lookup failed).
   */
  recipientTiers?: Readonly<Record<string, ContactTier>>;
  /** The subject line, when the channel has one: scanned for redaction placeholders like the content. */
  subject?: string;
  /** Resolved contact ids by lowercased recipient id, for matching a reply-to-task link's counterparties (#2312). */
  recipientContactIds?: Readonly<Record<string, string>>;
  /** The send goes out from the principal's own mailbox (#2474): the brief says it speaks as the principal. */
  senderProfile?: 'principal-mailbox';
  /** Principal mailbox only: who wrote the draft (#2474). Decides the questions on a principal-directed send. */
  draftAuthor?: DraftAuthor;
  /** Holds any stakes rating above this (#2474); unset = no ceiling. */
  stakesCeiling?: SendStakes;
  /** The message a principal-mailbox reply answers, used as origin evidence when the delegation walk finds none. */
  origin?: { content: string; at?: string; senderVerified: boolean };
  /**
   * Autonomous principal mailbox only (#2474): the thread's non-draft messages as text, which
   * `off-thread` judges the reply against. Missing reads as an empty thread (fail closed).
   */
  threadMessages?: ReadonlyArray<{ at?: string; text: string }>;
}

/**
 * Who wrote a principal-mailbox draft (#2474). `curia`: Curia created it. `curia-edited`: the
 * principal's draft that Curia edited, or one too old for the provenance lookback to tell.
 * `principal`: no sign of Curia's hand in the lookback.
 */
export type DraftAuthor = 'curia' | 'curia-edited' | 'principal';

export type BandReviewReport = { source: 'sent_without_review'; summary: string };

/**
 * What the review learned about a send it let through, for the spot-check pool (#2159
 * Phase 3): the gateway records them on the pool row so riskier sends are sampled more.
 */
export type BandReviewSignals = { speaksAsPrincipal?: boolean; bounced?: boolean };

/**
 * A requester's ask for the principal's data (#2312): the detected labels, the primary
 * non-principal recipient, and the title of the task it is for, when the evidence names one
 * (on one line, at most 80 characters). `counterparties` are every non-principal recipient,
 * normalized: the principal's answer is recorded for each. `outreachId` is the outreach row a
 * covering strong link points at, so a yes can learn the requester onto it.
 */
export type BandReviewAsk = { labels: string[]; requester: string; counterparties: string[]; taskTitle?: string; outreachId?: string };

export type BandReviewDecision =
  // dropQuote: only the quoted message's details stopped it; it goes without the quote (#2312).
  | { kind: 'send'; report?: BandReviewReport; signals?: BandReviewSignals; dropQuote?: { labels: string[] } }
  // strangerRequest: a recipient nobody can ask about requested these items; the digest is told (#2312).
  // heldBeside: a steering hold this bounce outranked (#2333). The drafter sees only `findings`; a
  // send that can't be rewritten (a saved draft) holds with both, so its warning still shows.
  | { kind: 'bounce'; findings: FilterFinding[]; strangerRequest?: { labels: string[]; requester: string }; heldBeside?: FilterFinding[] }
  // Not sent, and not held for the principal: the drafter must rewrite it again (80+ only). The gateway converts it to a hold for a relayed reply or a saved draft.
  // heldBeside: a hold this block outranked (#2333). The drafter sees only `findings`; the converted hold shows both.
  | { kind: 'block'; reason: string; findings: FilterFinding[]; heldBeside?: FilterFinding[] }
  // ask: the hold waits only on the principal's yes to a requester (#2312).
  | { kind: 'hold'; reason: string; findings: FilterFinding[]; ask?: BandReviewAsk };

export interface BandSendReviewDeps {
  judge: Pick<EscalationJudge, 'review' | 'isEnabled'> | undefined;
  evidence: Pick<SendEvidenceCollector, 'collect'>;
  limiter: FailOpenLimiter;
  /** Called once when the fail-open cap trips. Must not throw. */
  onLimiterTripped: () => Promise<void>;
  /** A contact's current tier (#2312). Null, or a throw, is no trusted authority. */
  contactTier: (contactId: string) => Promise<ContactTier | null>;
  /** The principal's own domains: never a counterparty org domain for a link (#2312). */
  nonOrgDomains?: ReadonlySet<string>;
  logger: Logger;
  now?: () => number;
}

export class BandSendReview {
  /** `rules`: what the draft bounced or was blocked for, so a recheck hold can say so. */
  private readonly bounced = new Map<string, LedgerEntry>();
  private readonly now: () => number;

  constructor(private readonly deps: BandSendReviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async review(input: BandReviewInput): Promise<BandReviewDecision> {
    const key = this.draftKey(input);
    const prior = this.priorBounce(key);
    const taskIds = [...new Set([...(prior?.taskEventIds ?? []), ...(input.taskEventId ? [input.taskEventId] : [])])];

    const items = input.detectedItems ?? [];
    // A quoted message's items (#2312) are ruled apart: the gateway sends without the quote
    // when they alone would stop the send, so they never decide the outcome otherwise.
    const own = items.filter((i) => i.field !== 'quote');
    const quoted = items.filter((i) => i.field === 'quote');
    // Past the cap the judge is not asked about the items at all: they are all unsupported. A
    // long quote does not push the message's own items past it: only those are asked then.
    const askedItems = items.length > 0 && items.length <= MAX_REVIEWED_ITEMS
      ? items
      : own.length > 0 && own.length <= MAX_REVIEWED_ITEMS ? own : undefined;
    const questions: readonly BriefQuestion[] = askedItems ? [...this.questionsFor(input), 'disclosure'] : this.questionsFor(input);
    const hasToken = REDACTION_TOKEN.test(input.content) || (input.subject !== undefined && REDACTION_TOKEN.test(input.subject));

    // Every send the stakes gate covers fails closed (#2473): no fail-open send, no cap spent.
    const stakesGated = questions.includes('stakes');
    // The subject goes out with the body, so a commitment made only there is rated too.
    const message = input.subject ? `Subject: ${input.subject}\n\n${input.content}` : input.content;
    const asked = await this.ask(input, questions, taskIds, message, askedItems);
    if (asked.originUnresolved && questions.includes('purpose')) {
      // A delegated send whose chain cannot be followed (#2499): purpose would be judged on the
      // coordinator's brief alone. Not a reviewer outage, so it holds at every band rather than
      // spending the fail-open allowance. A principal-directed send is not asked purpose, so it
      // takes the ordinary failure path below. The bounce ledger is kept, so a draft that
      // bounced before is still a recheck when its origin can be read.
      this.deps.logger.warn({ conversationId: input.conversationId, channel: input.channel, score: input.score }, 'band review: delegated send\'s origin cannot be read — holding');
      // The hold names the personal data and any redaction placeholder it carries, as the
      // reviewer-unavailable hold does, so the placeholder's finding travels with it.
      return this.unreviewedHold(ORIGIN_UNRESOLVED_REASON, own, hasToken);
    }
    let verdict = asked.verdict;
    if (verdict.ok && askedItems && !rulesOnEach(verdict.disclosures, askedItems)) {
      // The parser already refuses this; checked again because a gap here would read as a pass.
      this.deps.logger.error({ conversationId: input.conversationId, items: askedItems.length, rulings: verdict.disclosures?.length ?? 0 }, 'band review: verdict does not rule on every detected item — treating as a reviewer failure');
      verdict = { ok: false, failure: 'malformed' };
    }
    if (verdict.ok && questions.includes('off-thread') && typeof verdict.offThread !== 'boolean') {
      // Fail closed, like the gap above: the parser refuses this too, and a missing answer must
      // not read as "nothing new". Every autonomous send is stakes-gated, so this holds.
      this.deps.logger.error({ conversationId: input.conversationId }, 'band review: verdict does not answer off-thread — treating as a reviewer failure');
      verdict = { ok: false, failure: 'malformed' };
    }

    if (!verdict.ok) {
      if (own.length === 0 && !hasToken) {
        this.bounced.delete(key);
        if (prior) {
          // This draft already bounced on a finding the drafter has not shown resolved.
          // Failing open now would send exactly what the review flagged, so hold instead.
          this.deps.logger.warn({ conversationId: input.conversationId, failure: verdict.failure }, 'band review: reviewer unavailable on the recheck of a bounced draft — holding');
          return this.hold(BAND_RULES.unreviewed, recheckReason(prior.rules));
        }
        if (stakesGated) {
          this.deps.logger.warn({ conversationId: input.conversationId, channel: input.channel, failure: verdict.failure, score: input.score }, 'band review: reviewer unavailable — stakes unrated, holding at every band');
          return this.hold(BAND_RULES.unreviewed, STAKES_UNREVIEWED_REASON);
        }
        // An unreviewed quote never goes out: a fail-open send drops it.
        return withoutQuote(await this.onJudgeFailure(input, verdict.failure), quoted);
      }
      if (questions.includes('off-thread')) {
        // Fail closed (#2474): an autonomous reply nobody could check for off-thread information
        // holds, never bounces. A bounce would send a rewrite whose answer is still unknown.
        this.bounced.delete(key);
        this.deps.logger.warn({ conversationId: input.conversationId, channel: input.channel, failure: verdict.failure, items: items.length, token: hasToken }, 'band review: reviewer unavailable on an autonomous send with personal data or a placeholder — holding');
        return this.unreviewedHold(prior ? recheckReason(prior.rules) : STAKES_UNREVIEWED_REASON, own, hasToken);
      }
      // Personal data or a placeholder never goes out unreviewed: no fail-open send, and the
      // fail-open allowance is not spent on it.
      this.deps.logger.warn({ conversationId: input.conversationId, channel: input.channel, failure: verdict.failure, items: items.length, token: hasToken }, 'band review: reviewer unavailable with personal data or a placeholder in the send — not failing open');
      // At 80+ with no prior bounce this bounces for the items, which is not a send either: the
      // stakes stay unrated, and a recheck the reviewer still can't answer holds (#2473).
      const other = prior
        ? this.hold(BAND_RULES.unreviewed, recheckReason(prior.rules))
        : !isSpotCheckOrAbove(input.score)
          ? this.unreviewedHold(stakesGated ? STAKES_UNREVIEWED_REASON : UNREVIEWED_BELOW_80_REASON, own, hasToken)
          : undefined;
      const pii = this.unreviewedPiiOutcome(input, own, hasToken, prior !== undefined);
      // PII first, so its reason leads a merged hold: the bounce may have been for the items.
      return this.settle(key, taskIds, input, prior !== undefined, other ? combine(pii, other) : pii);
    }
    this.deps.limiter.recordJudgeSuccess();
    if (isAutonomousMailbox(input)) {
      // #2474: every message from the principal's own mailbox speaks for the principal, so the
      // judge is not asked; the stakes rating alone decides whether it may go out.
      verdict = { ...verdict, speaksAsPrincipal: true };
    }

    const other = this.otherRulesOutcome(input, verdict, items, prior !== undefined);
    const rulings = askedItems ? verdict.disclosures ?? [] : undefined;
    const piiOutcome = await this.piiOutcome(input, own, rulings, asked, hasToken, prior !== undefined);
    // At 80+ a hold for stakes alone waits for the drafter's rewrite of the details, like one
    // waiting for the rewrite of a claim (#2473): the approval must not show them as sent.
    const stakesOnly = other.kind === 'hold' && !other.ask && other.findings.every((f) => f.rule === BAND_RULES.speaksAsPrincipal);
    // A claim bounce carrying a stakes hold also outranks a disclosure hold that asks nobody:
    // the drafter fixes the claim first, and the recheck holds with the stakes finding beside it.
    const claimBounceHoldingStakes = other.kind === 'bounce'
      && other.heldBeside?.some((f) => f.rule === BAND_RULES.speaksAsPrincipal) === true
      && piiOutcome.kind === 'hold' && !piiOutcome.ask;
    const base = claimBounceHoldingStakes
      ? withHeldBeside(other, piiOutcome)
      : isSpotCheckOrAbove(input.score) && stakesOnly && rewritesDetails(piiOutcome)
        ? withHeldBeside(piiOutcome, other)
        : combine(other, piiOutcome);
    let decision = base;
    if (quoted.length > 0 && base.kind === 'send') {
      // The rest of the send goes out: the quote does too only if its items would.
      const quoteRulings = askedItems && quoted.every((q) => askedItems.includes(q)) ? rulings : undefined;
      const quote = await this.piiOutcome(input, quoted, quoteRulings, asked, false, prior !== undefined);
      decision = quote.kind === 'send' ? combine(base, quote) : withoutQuote(base, quoted);
    }
    if (questions.includes('off-thread') && verdict.offThread === true) {
      // #2474 (design D10): no score, ceiling or rewrite makes new information an autonomous
      // reply's to share, so this holds whatever else the review found.
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, score: input.score, other: decision.kind }, 'band review: held — an autonomous reply shares information that isn\'t on the thread');
      decision = offThreadHold(decision);
    }
    return this.settle(key, taskIds, input, prior !== undefined, decision);
  }

  /** The band rules other than disclosure, as before #2312. Writes nothing to the ledger. */
  private otherRulesOutcome(
    input: BandReviewInput,
    verdict: BriefAnswers,
    detected: readonly BriefDetectedItem[],
    hasPrior: boolean,
  ): BandReviewDecision {
    const speaksHeld = verdict.speaksAsPrincipal === true ? stakesHold(verdict, input.score, input.stakesCeiling) : undefined;
    if (verdict.purpose === 'steered') {
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel }, 'band review: held — steered by an outsider');
      const steered = this.hold(BAND_RULES.steered, 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.');
      // Both reasons hold it, so the approval shows both (#2333).
      return speaksHeld && steered.kind === 'hold'
        ? { ...steered, findings: [...steered.findings, speaksHeld] }
        : steered;
    }

    const claims = verdict.unsupportedClaims ?? [];
    // Detected items are ruled under disclosure only (#2312): an unneeded-disclosure quote that
    // overlaps one is dropped, or an authorized item would bounce here anyway.
    const unneeded = (verdict.unnecessaryItems ?? []).filter((q) => !detected.some((d) => overlaps(q, d.text)));
    // Below 80 a hold for speaking as the principal comes first, as before #2473. At 80+ a stakes
    // hold waits for the drafter's rewrite: the principal is asked about a draft the review would
    // send, not one it would bounce. The bounce or block carries the hold (`heldBeside`), so a
    // send nobody can rewrite still shows it.
    if (speaksHeld && (!isSpotCheckOrAbove(input.score) || (claims.length === 0 && unneeded.length === 0))) {
      this.deps.logger.info({ conversationId: input.conversationId, channel: input.channel, score: input.score, stakes: verdict.stakes }, 'band review: held — speaks for the principal below what its stakes need');
      return { kind: 'hold', reason: speaksHeld.detail, findings: [speaksHeld] };
    }
    const beside = speaksHeld ? { heldBeside: [speaksHeld] } : {};
    if (claims.length === 0 && unneeded.length === 0) {
      return { kind: 'send', signals: { ...(verdict.speaksAsPrincipal === true ? { speaksAsPrincipal: true } : {}), ...(hasPrior ? { bounced: true } : {}) } };
    }

    if (!hasPrior) {
      this.deps.logger.info(
        { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: unneeded.length },
        'band review: bounced to the drafter',
      );
      return { kind: 'bounce', findings: this.bounceFindings(input.content, claims, unneeded, detected), ...beside };
    }

    // The one bounce is spent. Below 80 the principal decides; at 80+ the message is not sent.
    if (!isSpotCheckOrAbove(input.score)) {
      return this.hold(BAND_RULES.ungrounded, 'Held for the principal: it still states things about the principal that nothing looked up supports.');
    }
    this.deps.logger.info(
      { conversationId: input.conversationId, channel: input.channel, claims: claims.length, items: unneeded.length, outcome: 'blocked' },
      'band review: blocked — findings survived the rewrite',
    );
    return { kind: 'block', reason: BLOCK_REASON, findings: this.bounceFindings(input.content, claims, unneeded, detected), ...beside };
  }

  /**
   * The disclosure policy (#2312). The judge says why each item is there; code decides whether
   * anyone with the authority to share it directed the work, so a ruling of `directed` counts
   * only for an authority the evidence shows. `rulings` is undefined when the judge was not
   * asked (more items than it reviews at once): every item is then unsupported.
   */
  private async piiOutcome(
    input: BandReviewInput,
    items: readonly BriefDetectedItem[],
    rulings: readonly DisclosureRuling[] | undefined,
    asked: { authority?: SendAuthority; decisions?: readonly DisclosureDecisionRow[]; linkedOutreachId?: string },
    hasToken: boolean,
    hasPrior: boolean,
  ): Promise<BandReviewDecision> {
    const { authority } = asked;
    const others = nonPrincipalRecipients(input);
    const said = principalSaid(others, asked.decisions ?? []);
    // A link counts only for a send to the counterparties it links (#2312).
    const covered = linkCoverage(input, authority, this.deps.nonOrgDomains);
    const linkCovers = others.every(covered);
    // Only when every non-principal recipient can be asked about: a known or trusted contact, or
    // one a link to the principal's own task covers (a weak link gives no authority, but a reply
    // about their task is worth asking them about). The link's originator is the task's (or
    // row's), never the sender's. Anyone else on the send makes it a stranger's request.
    const tierOf = recipientTierOf(input);
    const linkAsks = linkToPrincipalTask(authority);
    const askable = others.length > 0 && others.every((r) => {
      const tier = tierOf(r);
      return tier === 'known' || tier === 'trusted' || (linkAsks && covered(r));
    });
    const toRewrite: FilterFinding[] = [];
    const holds: FilterFinding[] = [];
    // The held items an ask covers, and whether anything else was held (then no ask).
    const askLabels = new Set<string>();
    let heldOtherwise = false;
    const strangerAsked = new Set<string>();
    const declined = new Set<string>();
    const saidYes = new Set<string>();
    // Who directed the work; an ask names the task only when the principal's authority is that task's.
    let who: Authority = 'none';

    if (items.length > 0 && rulings === undefined) {
      toRewrite.push({ rule: BAND_RULES.pii, detail: TOO_MANY_DETAIL });
    } else if (items.length > 0) {
      const byId = new Map(rulings!.map((r) => [r.id, r]));
      const found = await this.authorityOf(authority, rulings!, linkCovers);
      who = found.who;
      const { trusted } = found;
      const unsupported = new Set<string>();
      const askFirst = new Set<string>();
      const inferredBelow80 = new Set<string>();
      const taskDirectedBelow80 = new Set<string>();
      const trustedDirected = new Set<string>();
      for (const item of items) {
        // rulesOnEach() guaranteed one ruling per item.
        const r = byId.get(item.id)!;
        if (r.basis === 'directed' && who === 'principal') continue;
        // The principal already answered for this label and these recipients on this thread.
        const answer = said(item.label);
        if (answer === 'no') { declined.add(item.label); continue; }
        if (answer === 'yes') { saidYes.add(item.label); continue; }
        // The drafting turn's own trusted originator directed it: held for the principal at any
        // score. A trusted contact is not the principal, and their tier grants no
        // send_on_behalf (config/role-defaults.yaml), so the principal approves the disclosure.
        // Not an ask: the recipient did not ask, the trusted contact did.
        if (r.basis === 'directed' && trusted) { trustedDirected.add(item.label); heldOtherwise = true; continue; }
        // Held below 80 for the principal: an ask when it is their task and an askable recipient
        // requested it. Under the principal's own turn nobody is asking: an ordinary hold.
        const heldForTask = (set: Set<string>) => {
          set.add(item.label);
          if (who === 'principal-task' && r.requested && askable) askLabels.add(item.label);
          else heldOtherwise = true;
        };
        // The principal set the task, but this turn is not theirs: a directed ruling counts
        // only as inferred, since the principal did not direct this send themselves.
        if (r.basis === 'directed' && who === 'principal-task') {
          if (!isSpotCheckOrAbove(input.score)) heldForTask(taskDirectedBelow80);
          continue;
        }
        if (r.basis === 'inferred' && (who === 'principal' || who === 'principal-task')) {
          if (!isSpotCheckOrAbove(input.score)) heldForTask(inferredBelow80);
          continue;
        }
        // Every other combination is unsupported.
        if (r.requested && askable) {
          askFirst.add(item.label);
          askLabels.add(item.label);
        } else {
          unsupported.add(item.label);
          if (r.requested) strangerAsked.add(item.label);
        }
      }
      for (const label of declined) {
        toRewrite.push({ rule: BAND_RULES.pii, detail: `The principal declined sharing the principal's ${describePiiLabels([label])} with this recipient on this thread. Rewrite without it.` });
      }
      if (unsupported.size > 0) {
        toRewrite.push({
          rule: BAND_RULES.pii,
          detail: `This message shares personal details nothing authorizes for this recipient: ${[...unsupported].join(', ')}. Rewrite it without them${askable ? ', or ask the principal' : ''}.`,
        });
      }
      if (inferredBelow80.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: it shares personal details (${[...inferredBelow80].join(', ')}) that the principal's request needs but did not name, and this band asks first.` });
      }
      if (taskDirectedBelow80.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: it shares personal details (${[...taskDirectedBelow80].join(', ')}) for a task the principal set, not at their request in this conversation, and this band asks first.` });
      }
      if (askFirst.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: the recipient asked for personal details (${[...askFirst].join(', ')}) that nothing authorizes sharing yet.` });
      }
      if (trustedDirected.size > 0) {
        holds.push({ rule: BAND_RULES.pii, detail: `Held for the principal: a trusted contact asked for the principal's personal details (${[...trustedDirected].join(', ')}) to be sent, and the principal approves sending them to anyone else.` });
      }
      // Ids, labels and counts only: the judge's reasons and the items' text can echo the data.
      this.deps.logger.info(
        {
          conversationId: input.conversationId, channel: input.channel, items: items.length, authority: who, trustedOriginator: trusted,
          ...(authority?.linkedTask ? { linkStrength: authority.linkedTask.strength, linkCovers } : {}),
          unsupported: [...unsupported], askFirst: [...askFirst], inferredBelow80: [...inferredBelow80], taskDirectedBelow80: [...taskDirectedBelow80], trustedDirected: [...trustedDirected],
          principalDeclined: [...declined], principalSaidYes: [...saidYes],
        },
        'band review: disclosure rulings applied',
      );
    }
    if (hasToken) toRewrite.push({ rule: BAND_RULES.token, detail: TOKEN_DETAIL });

    if (toRewrite.length > 0) {
      const outcome = this.rewriteOutcome(input, toRewrite, hasPrior);
      const requester = primaryRequester(input);
      // Only the first bounce is noted: a recheck blocks or holds, and says so itself.
      if (outcome.kind === 'bounce' && strangerAsked.size > 0 && requester !== undefined) {
        return { ...outcome, strangerRequest: { labels: [...strangerAsked], requester } };
      }
      return outcome;
    }
    if (holds.length > 0) {
      const requester = primaryRequester(input);
      if (askLabels.size > 0 && !heldOtherwise && requester !== undefined) {
        const taskTitle = askTaskTitle(authority, who, linkCovers);
        // Only a strong link names its row: the ask shows no task for a weak one, so a yes
        // can't confirm which row the requester belongs on.
        const outreachId = linkCovers && authority?.linkedTask?.strength === 'strong' ? asked.linkedOutreachId : undefined;
        return {
          kind: 'hold', reason: holds[0]!.detail, findings: holds,
          ask: {
            labels: [...askLabels], requester, counterparties: nonPrincipalRecipients(input),
            ...(taskTitle ? { taskTitle } : {}), ...(outreachId ? { outreachId } : {}),
          },
        };
      }
      return { kind: 'hold', reason: holds[0]!.detail, findings: holds };
    }
    return { kind: 'send' };
  }

  /** The judge failed with items or a placeholder present: nothing is authorized. */
  private unreviewedPiiOutcome(input: BandReviewInput, items: readonly BriefDetectedItem[], hasToken: boolean, hasPrior: boolean): BandReviewDecision {
    const labels = [...new Set(items.map((i) => i.label))].join(', ');
    const decisions: BandReviewDecision[] = [];
    if (items.length > 0) {
      decisions.push(hasPrior
        ? this.hold(BAND_RULES.pii, `Held for the principal: it shares personal details (${labels}), and the reviewer was unavailable to check them.`)
        : {
          kind: 'bounce',
          findings: [{
            rule: BAND_RULES.pii,
            detail: items.length > MAX_REVIEWED_ITEMS
              ? TOO_MANY_DETAIL
              : `The reviewer could not check the personal details in this message: ${labels}. Rewrite it without them.`,
          }],
        });
    }
    if (hasToken) decisions.push(this.rewriteOutcome(input, [{ rule: BAND_RULES.token, detail: TOKEN_DETAIL }], hasPrior));
    return decisions.reduce(combine);
  }

  /** The reviewer is down and the send holds: name (by label) the personal data it carries. */
  private unreviewedHold(reason: string, items: readonly BriefDetectedItem[], hasToken: boolean): BandReviewDecision {
    const findings: FilterFinding[] = [{ rule: BAND_RULES.unreviewed, detail: reason }];
    if (items.length > 0) {
      findings.push({ rule: BAND_RULES.pii, detail: `It contains personal details the reviewer could not check: ${[...new Set(items.map((i) => i.label))].join(', ')}.` });
    }
    if (hasToken) findings.push({ rule: BAND_RULES.token, detail: TOKEN_DETAIL });
    return { kind: 'hold', reason, findings };
  }

  /** Findings the drafter must rewrite away: bounce once, then block at 80+ or hold below. */
  private rewriteOutcome(input: BandReviewInput, findings: FilterFinding[], hasPrior: boolean): BandReviewDecision {
    if (!hasPrior) return { kind: 'bounce', findings };
    if (isSpotCheckOrAbove(input.score)) return { kind: 'block', reason: BLOCK_REASON, findings };
    return {
      kind: 'hold',
      reason: 'Held for the principal: after one rewrite it still has personal details nothing authorizes, or a redaction placeholder.',
      findings,
    };
  }

  /**
   * Who directed the work, from trusted state only. The principal: their own turn (a live turn,
   * or a wake they originated). The principal's task: only the bound or root task is theirs,
   * not the drafting turn, so a directed ruling counts as inferred. A strong reply-to-task link
   * to a task (or its root) the principal directed counts the same, when it covers every
   * recipient (`linkCovers`); a weak one never does. Anything else is no authority.
   *
   * `trusted` is separate, since it is about the drafting turn rather than a task: its
   * originator's stamped tier and tier now are both trusted, and their message authenticated
   * them. A directed ruling is then held for the principal at any score, even under the
   * principal's task (#2312). Never for the principal's own turn. A failed tier read is not trusted.
   */
  private async authorityOf(
    a: SendAuthority | undefined,
    rulings: readonly DisclosureRuling[],
    linkCovers: boolean,
  ): Promise<{ who: Authority; trusted: boolean }> {
    if (!a) return { who: 'none', trusted: false };
    // `liveTurn` is context for the judge only. Code trusts the stamped role: stampOriginator
    // sets systemRole 'principal' only from the resolved sender, and a wake carries the
    // originator its job was created with.
    if (a.originator?.systemRole === 'principal') return { who: 'principal', trusted: false };
    // Only an exact 'strong' counts; the collector already dropped a malformed link.
    const task = [a.boundTask?.originator, a.rootTask?.originator].some((o) => o?.systemRole === 'principal')
      || (linkCovers && a.linkedTask?.strength === 'strong' && linkToPrincipalTask(a));
    return { who: task ? 'principal-task' : 'none', trusted: await this.trustedOriginator(a.originator, rulings) };
  }

  private async trustedOriginator(o: SendAuthority['originator'], rulings: readonly DisclosureRuling[]): Promise<boolean> {
    // Only a directed ruling uses trusted authority, so skip the lookup otherwise.
    if (!o || o.tier !== 'trusted' || o.authenticated !== true || !rulings.some((r) => r.basis === 'directed')) return false;
    try {
      return (await this.deps.contactTier(o.contactId)) === 'trusted';
    } catch (err) {
      this.deps.logger.error({ err, contactId: o.contactId }, 'band review: could not read the originator\'s current tier — no trusted authority');
      return false;
    }
  }

  /** Record the final outcome in the one-bounce ledger and return it. */
  private settle(key: string, taskIds: string[], input: BandReviewInput, hasPrior: boolean, decision: BandReviewDecision): BandReviewDecision {
    if (decision.kind === 'bounce' || decision.kind === 'block') {
      // A block keeps the entry and refreshes its time: the drafter's next attempt is still a
      // recheck, and a clean one clears it.
      this.bounced.set(key, { taskEventIds: taskIds, at: this.now(), rules: decision.findings.map((f) => f.rule) });
      return decision;
    }
    this.bounced.delete(key);
    if (decision.kind === 'send' && hasPrior) {
      // Metric (spec "Measuring success"): a bounce resolved by the drafter looking it up.
      this.deps.logger.info({ conversationId: input.conversationId, outcome: 'resolved_by_lookup' }, 'band review: bounced send passed on recheck');
    }
    return decision;
  }

  private questionsFor(input: BandReviewInput): readonly BriefQuestion[] {
    if (input.senderProfile === 'principal-mailbox' && input.principalDirected) {
      // #2474 (design D2): the principal's own words are not fact-checked; only disclosure is
      // asked, and only when items are detected. A Curia-written draft the principal told it to
      // send is checked for who it serves and what it claims ("handle the easy ones" answers
      // outsider mail on a live turn). A draft Curia edited is asked purpose only (final review
      // S1): a steering check on whom the edit serves, with no fact-check of the principal's words.
      if (input.draftAuthor === 'principal') return [];
      return input.draftAuthor === 'curia-edited' ? ['purpose'] : ['purpose', 'grounding'];
    }
    // #2474: an autonomous send from the principal's mailbox speaks for the principal by
    // definition, so that question is not asked (review() sets it); stakes still is.
    // `off-thread` (#2474, design D10) is asked here only: a principal-directed send may share
    // what the principal chose to.
    if (isAutonomousMailbox(input)) return ['purpose', 'stakes', 'grounding', 'necessity', 'off-thread'];
    return input.principalDirected ? ['grounding'] : ALL_QUESTIONS;
  }

  private async ask(
    input: BandReviewInput,
    questions: readonly BriefQuestion[],
    taskIds: string[],
    message: string,
    detectedItems: readonly BriefDetectedItem[] | undefined,
  ): Promise<{ verdict: BriefVerdict; authority?: SendAuthority; decisions?: DisclosureDecisionRow[]; linkedOutreachId?: string; originUnresolved?: true }> {
    if (!this.deps.judge?.isEnabled()) return { verdict: { ok: false, failure: 'disabled' } };
    const collected = await this.deps.evidence.collect(taskIds, {
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      counterparties: nonPrincipalRecipients(input),
    });
    // Without evidence every claim looks unsupported; that is a review failure, not a bounce.
    if (collected.unavailable) {
      return { verdict: { ok: false, failure: 'unreachable' }, ...(collected.originUnresolved ? { originUnresolved: true as const } : {}) };
    }
    // Decisions and the outreach id stay with code: the judge reads the decisions as sentences.
    const { decisions, linkedOutreachId, originUnresolved, ...collectedEvidence } = collected;
    // An autonomous principal-mailbox reply (#2474) with no delegation origin is judged against
    // the message it answers. A delegation origin wins: it is what started Curia's work.
    const evidence = input.origin && collectedEvidence.originContent === undefined
      ? {
        ...collectedEvidence,
        originContent: replyTargetEvidence(input.origin.content),
        originKind: 'reply_target' as const,
        ...(input.origin.at ? { originAt: input.origin.at } : {}),
        originSenderVerified: input.origin.senderVerified,
      }
      : collectedEvidence;
    // Destructured only to keep it out of `evidence`; the failure path above is the one that carries it.
    // The repo's no-unused-vars rule has no underscore exemption, so discard it explicitly.
    void originUnresolved;
    const principalDecisions = describeDecisions(decisions, nonPrincipalRecipients(input));
    // Newest first, so the note leads. The relay's principal note is not under the drafting
    // task in audit_log (its parent is the agent.response), so it arrives with the send
    // rather than from the collector.
    const reportsToPrincipal = input.reportedToPrincipal
      ? [reportEvidence(input.reportedToPrincipal), ...(evidence.reportsToPrincipal ?? [])]
      : evidence.reportsToPrincipal;
    const verdict = await this.deps.judge.review({
      questions,
      message,
      recipients: input.recipients,
      ...(input.principalRecipients ? { principalRecipients: input.principalRecipients } : {}),
      ...(detectedItems ? { detectedItems } : {}),
      band: AutonomyService.bandForScore(input.score),
      evidence: {
        ...evidence,
        ...(reportsToPrincipal ? { reportsToPrincipal } : {}),
        ...(principalDecisions.length > 0 ? { principalDecisions } : {}),
        // Only with the question that reads it (#2474). No thread reads as empty: fail closed.
        ...(questions.includes('off-thread') ? threadEvidence(input.threadMessages ?? []) : {}),
      },
      conversationId: input.conversationId ?? 'system',
      ...(input.senderProfile ? { senderProfile: input.senderProfile } : {}),
    });
    return {
      verdict, authority: evidence.authority,
      ...(decisions ? { decisions } : {}), ...(linkedOutreachId ? { linkedOutreachId } : {}),
    };
  }

  private async onJudgeFailure(input: BandReviewInput, failure: string): Promise<BandReviewDecision> {
    if (!isSpotCheckOrAbove(input.score)) {
      this.deps.logger.warn({ failure, channel: input.channel, score: input.score }, 'band review: reviewer unavailable — holding (below 80)');
      return this.hold(BAND_RULES.unreviewed, UNREVIEWED_BELOW_80_REASON);
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
  private bounceFindings(content: string, claims: string[], items: string[], detected: readonly BriefDetectedItem[]): FilterFinding[] {
    // A quote holding a detected item's value is never shown: findings carry labels, not values.
    const inMessage = (quotes: string[]) => quotes
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && content.includes(q) && !detected.some((d) => containsFolded(q, d.text)));
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

  private priorBounce(key: string): LedgerEntry | undefined {
    const entry = this.bounced.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > BOUNCE_TTL_MS) {
      this.bounced.delete(key);
      return undefined;
    }
    return entry;
  }
}

const STRICTNESS: Record<BandReviewDecision['kind'], number> = { send: 0, bounce: 1, hold: 2, block: 3 };

/**
 * The hold for a send that speaks for the principal below the score its stakes need (#2473), or
 * undefined when the score clears it. A sending setting's `ceiling` (#2474) also holds any rating
 * above it, and the finding says so (except financial_or_legal, which always asks). The finding names the rating and the judge's reason, so
 * the approval says why it asked. A missing rating cannot happen (the review asks both questions together
 * and the parser requires every answer); it is treated as the strictest.
 */
function stakesHold(verdict: BriefAnswers, score: number, ceiling?: SendStakes): FilterFinding | undefined {
  const stakes = verdict.stakes ?? 'financial_or_legal';
  const min = STAKES_MIN_SCORE[stakes];
  // A sending setting's ceiling (#2474) holds a rating above it whatever the score.
  const aboveCeiling = ceiling !== undefined && STAKES_RANK[stakes] > STAKES_RANK[ceiling];
  const scoreClears = min !== null && score >= min;
  if (!aboveCeiling && scoreClears) return undefined;
  // The judge's overall reason stands in when it left the stakes reason out.
  const why = (verdict.stakesReason?.trim() ? verdict.stakesReason : verdict.reason ?? '').replace(/\s+/g, ' ').trim();
  // Count code points, not UTF-16 units, so the cut never leaves half a surrogate pair.
  const points = Array.from(why);
  const shown = points.length > STAKES_REASON_MAX ? `${points.slice(0, STAKES_REASON_MAX - 1).join('').trimEnd()}…` : why;
  // Said whenever the setting holds it, even when the score would too: raising the score alone
  // would not send it. Not for financial_or_legal, whose lead already says it always asks.
  const aboveNote = aboveCeiling && stakes !== 'financial_or_legal' ? ' Above the sending setting.' : '';
  return {
    rule: BAND_RULES.speaksAsPrincipal,
    detail: `${STAKES_HOLD_LEAD[stakes]}${aboveNote} Stakes: ${STAKES_LABEL[stakes]}.${shown ? ` Why: ${shown}` : ''}`,
  };
}

/** A send from the principal's own mailbox that no live principal turn directed (#2474). */
function isAutonomousMailbox(input: BandReviewInput): boolean {
  return input.senderProfile === 'principal-mailbox' && !input.principalDirected;
}

/**
 * The hold for an autonomous reply that shares information not on the thread (#2474). It leads;
 * whatever else the review found comes along, so the principal sees every reason. An ask is
 * dropped, like any hold beside one: a yes to the requester would not make the reply sendable.
 *
 * The reason the digest shows carries the others too (#2474 final fixes A11, final review M3): a
 * stakes finding's rating and why ("Stakes: financial or legal. Why: …"), any other finding by
 * its rule name. Otherwise a reply that is both off-thread and financial reaches the principal
 * as off-thread only.
 */
function offThreadHold(d: BandReviewDecision): BandReviewDecision {
  const others = d.kind === 'send' ? [] : [...d.findings, ...(d.kind === 'hold' ? [] : d.heldBeside ?? [])];
  const also = [...new Set(others.map((f) => {
    const stakesAt = f.rule === BAND_RULES.speaksAsPrincipal ? f.detail.indexOf('Stakes: ') : -1;
    return stakesAt >= 0 ? f.detail.slice(stakesAt).trim() : f.rule;
  }))];
  const reason = also.length > 0 ? `${OFF_THREAD_REASON} Also: ${also.join('; ')}${/[.!?…]$/.test(also[also.length - 1]!) ? '' : '.'}` : OFF_THREAD_REASON;
  return { kind: 'hold', reason, findings: [{ rule: BAND_RULES.offThread, detail: OFF_THREAD_REASON }, ...others] };
}

/** A bounce with a personal-details finding: the drafter must rewrite without an item (#2333). */
function rewritesDetails(d: BandReviewDecision): boolean {
  return d.kind === 'bounce' && d.findings.some((f) => f.rule === BAND_RULES.pii);
}

/** The bounce or block, carrying the reasons of the hold it outranked (#2333). */
function withHeldBeside(winner: BandReviewDecision, hold: BandReviewDecision): BandReviewDecision {
  if ((winner.kind !== 'bounce' && winner.kind !== 'block') || hold.kind !== 'hold') return winner;
  return { ...winner, heldBeside: [...(winner.heldBeside ?? []), ...hold.findings] };
}

/**
 * A hold raised because the send is steered by an outsider, with no ask (#2333). It may also
 * speak for the principal below what its stakes need (#2473): steering is what would hand the details to an outsider.
 */
function steeredOnly(d: BandReviewDecision): boolean {
  return d.kind === 'hold' && !d.ask
    && d.findings.some((f) => f.rule === BAND_RULES.steered)
    && d.findings.every((f) => f.rule === BAND_RULES.steered || f.rule === BAND_RULES.speaksAsPrincipal);
}

/** Who directed the work behind a send: the principal's own turn, the principal's task, or nobody. */
type Authority = 'principal' | 'principal-task' | 'none';

/**
 * The strictest of two outcomes: block > hold > bounce > send. Equal outcomes merge, so the
 * drafter or the principal sees every rule that fired; the first one's reason leads.
 *
 * Two exceptions. A bounce beats an ask (#2312): the ask waits only on the principal's yes, and
 * a yes would send the other finding too; the drafter fixes that first, and the recheck asks.
 * A bounce over personal details beats a hold for steering (#2333), alone or beside speaking for
 * the principal below what its stakes need: that approval would show the details as sent if approved, to an
 * outsider steering the send. The drafter rewrites without them, and a recheck that is still
 * steered holds without them. The bounce carries the hold's findings (`heldBeside`), so a saved
 * draft the gateway holds still shows them.
 *
 * Two holds merge into a plain hold, except that an ask survives a hold for speaking as the
 * principal below what its stakes need (#2312, #2473): the principal is asked first either way, and the question names
 * who asked and records the answer. The approval shows the other reason beside it. Any other
 * hold (steered, a judge failure) drops the ask, so its warning leads.
 */
export function combine(a: BandReviewDecision, b: BandReviewDecision): BandReviewDecision {
  if (a.kind === 'bounce' && b.kind === 'hold' && b.ask) return a;
  if (b.kind === 'bounce' && a.kind === 'hold' && a.ask) return b;
  if (rewritesDetails(a) && steeredOnly(b)) return withHeldBeside(a, b);
  if (rewritesDetails(b) && steeredOnly(a)) return withHeldBeside(b, a);
  // A block outranks a hold, but the gateway holds a block nobody can rewrite: it keeps the hold's reasons (#2333).
  if (a.kind === 'block' && b.kind === 'hold') return withHeldBeside(a, b);
  if (b.kind === 'block' && a.kind === 'hold') return withHeldBeside(b, a);
  if (STRICTNESS[a.kind] !== STRICTNESS[b.kind]) return STRICTNESS[a.kind] > STRICTNESS[b.kind] ? a : b;
  if (a.kind === 'send' && b.kind === 'send') {
    const report = a.report ?? b.report;
    const signals = a.signals || b.signals ? { ...a.signals, ...b.signals } : undefined;
    const dropped = [...new Set([...(a.dropQuote?.labels ?? []), ...(b.dropQuote?.labels ?? [])])];
    return {
      kind: 'send',
      ...(report ? { report } : {}),
      ...(signals ? { signals } : {}),
      ...(a.dropQuote || b.dropQuote ? { dropQuote: { labels: dropped } } : {}),
    };
  }
  if (a.kind === 'bounce' && b.kind === 'bounce') {
    const strangerRequest = a.strangerRequest ?? b.strangerRequest;
    const heldBeside = [...(a.heldBeside ?? []), ...(b.heldBeside ?? [])];
    return {
      kind: 'bounce',
      findings: [...a.findings, ...b.findings],
      ...(strangerRequest ? { strangerRequest } : {}),
      ...(heldBeside.length > 0 ? { heldBeside } : {}),
    };
  }
  if (a.kind === 'block' && b.kind === 'block') {
    const heldBeside = [...(a.heldBeside ?? []), ...(b.heldBeside ?? [])];
    return { kind: 'block', reason: a.reason, findings: [...a.findings, ...b.findings], ...(heldBeside.length > 0 ? { heldBeside } : {}) };
  }
  if (a.kind === 'hold' && b.kind === 'hold') {
    const findings = [...a.findings, ...b.findings];
    const ask = a.ask ?? b.ask;
    const plain = a.ask ? b : a;
    // Leads with the ask's reason, so the question and its reason stay together.
    if (ask && !(a.ask && b.ask) && plain.findings.every((f) => f.rule === BAND_RULES.speaksAsPrincipal)) {
      return { kind: 'hold', reason: (a.ask ? a : b).reason, findings, ask };
    }
    return { kind: 'hold', reason: a.reason, findings };
  }
  return a;
}

/**
 * A send that goes out without its quoted message (#2312), when the quote has items. Quoted
 * history, not the drafter's text, so this is not a cut. Any other outcome is unchanged.
 */
function withoutQuote(decision: BandReviewDecision, quoted: readonly BriefDetectedItem[]): BandReviewDecision {
  if (decision.kind !== 'send' || quoted.length === 0) return decision;
  return { ...decision, dropQuote: { labels: [...new Set(quoted.map((q) => q.label))] } };
}

/** The first recipient who is not the principal: who an ask or a stranger's request names (#2312). */
function primaryRequester(input: BandReviewInput): string | undefined {
  const principals = new Set((input.principalRecipients ?? []).map(bareId));
  return input.recipients.find((r) => !principals.has(bareId(r)));
}

/** Every recipient who is not the principal, normalized and once each: who a decision is for (#2312). */
function nonPrincipalRecipients(input: BandReviewInput): string[] {
  const principals = new Set((input.principalRecipients ?? []).map(bareId));
  return [...new Set(input.recipients.map(bareId).filter((r) => !principals.has(r)))];
}

/**
 * The principal's standing answer for a label on this thread (#2312): 'no' when any recipient's
 * latest decision is no, 'yes' when every recipient's is yes, otherwise none. A send to the
 * principal alone has no recipient to answer for.
 */
function principalSaid(recipients: readonly string[], decisions: readonly DisclosureDecisionRow[]): (label: string) => 'yes' | 'no' | undefined {
  const latest = new Map(decisions.map((d) => [`${normalizeCounterparty(d.counterparty)}\u0000${d.label}`, d.decision]));
  return (label) => {
    if (recipients.length === 0) return undefined;
    const answers = recipients.map((r) => latest.get(`${r}\u0000${label}`));
    if (answers.includes('no')) return 'no';
    return answers.every((a) => a === 'yes') ? 'yes' : undefined;
  };
}

/**
 * Decisions as the judge reads them: the label and "this recipient", never the identifier; once
 * per label. A yes or no is stated only when it holds for the send as code applies it
 * (principalSaid): a yes from every recipient, or a no from any. A yes from some recipients
 * only is partial, and said to be, since code does not treat it as a yes.
 */
function describeDecisions(decisions: CollectedEvidence['decisions'], recipients: readonly string[]): string[] {
  const said = principalSaid(recipients, decisions ?? []);
  return [...new Set((decisions ?? []).map((d) => d.label))].map((label) => {
    const answer = said(label);
    const what = describePiiLabels([label]);
    return answer
      ? `The principal already said ${answer} to sharing ${what} with this recipient on this thread.`
      : `The principal answered about sharing ${what} for some of the recipients only, on this thread.`;
  });
}

const TASK_TITLE_MAX = 80;

/**
 * The task an ask is for, named only when the principal's authority comes from it (#2312): a
 * strong link covering the recipients to the principal's task names that task (or its root),
 * otherwise the bound task names itself when the principal set it, else the root. Undefined for any
 * other ask, or when none has a title. It is quoted in the principal's question, so it is made
 * one line, its double quotes become single ones, and it is cut to 80 characters with an ellipsis.
 */
function askTaskTitle(a: SendAuthority | undefined, who: Authority, linkCovers: boolean): string | undefined {
  if (who !== 'principal-task') return undefined;
  const viaLink = linkCovers && a?.linkedTask?.strength === 'strong' && linkToPrincipalTask(a);
  // The task that carries the principal's authority: the bound task when the principal set
  // it, otherwise the root.
  const raw = viaLink
    ? a?.linkedTask?.title ?? a?.linkedTask?.root?.title
    : a?.boundTask?.originator?.systemRole === 'principal' ? a.boundTask.title : a?.rootTask?.title;
  const title = raw?.replace(/\s+/g, ' ').replace(/"/g, '\'').trim();
  if (!title) return undefined;
  return title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : title;
}

// Lives with the ask it words (the approval's delivery rebuilds it), re-exported for callers here.
export { describePiiLabels };

/** The link is to a task the principal directed: its own originator, or its project root's. */
function linkToPrincipalTask(a: SendAuthority | undefined): boolean {
  const l = a?.linkedTask;
  return l?.originator?.systemRole === 'principal' || l?.root?.originator?.systemRole === 'principal';
}

/** A channel id as an address: the last `<addr>` when written with a display name, lowercased. */
const bareId = normalizeCounterparty;

/**
 * A recipient's tier for an ask (#2312), by normalized id: from `recipientTiers` when the caller
 * resolved every recipient, otherwise `recipientTier` for the primary requester alone.
 */
function recipientTierOf(input: BandReviewInput): (recipient: string) => ContactTier | undefined {
  if (input.recipientTiers) {
    const tiers = new Map(Object.entries(input.recipientTiers).map(([k, v]) => [bareId(k), v]));
    return (r) => tiers.get(r);
  }
  const primary = primaryRequester(input);
  const primaryId = primary !== undefined ? bareId(primary) : undefined;
  return (r) => (r === primaryId ? input.recipientTier : undefined);
}

/**
 * Whether the link covers a recipient (normalized): the linked sender (by contact, when the
 * sender resolved), or an address, contact id or org domain on the outreach
 * row. No link, or no readable row, covers no one (fail closed). A send counts as covered when
 * every non-principal recipient is, so one to the principal alone is.
 */
function linkCoverage(input: BandReviewInput, a: SendAuthority | undefined, nonOrgDomains: ReadonlySet<string> | undefined): (recipient: string) => boolean {
  const cp = a?.linkedTask?.counterparty;
  if (!cp) return () => false;
  // The linked sender is matched by contact id: an originator carries no address.
  const sender = a!.originator ? bareId(a!.originator.contactId) : undefined;
  const senderContact = sender !== undefined && isUuid(sender) ? sender : undefined;
  const contactOf = new Map(Object.entries(input.recipientContactIds ?? {}).map(([k, v]) => [bareId(k), v.trim().toLowerCase()]));
  const addresses = new Set(cp.addresses);
  const contacts = new Set(cp.contactIds);
  const domains = new Set(cp.domains);
  return (r) => {
    if (addresses.has(r)) return true;
    const contact = contactOf.get(r);
    if (contact !== undefined && (contact === senderContact || contacts.has(contact))) return true;
    return orgDomainsOf([r], nonOrgDomains).some((d) => domains.has(d));
  };
}

/** Exactly one ruling for each asked item. */
function rulesOnEach(rulings: readonly DisclosureRuling[] | undefined, items: readonly BriefDetectedItem[]): boolean {
  if (rulings === undefined || rulings.length !== items.length) return false;
  const ids = new Set(rulings.map((r) => r.id));
  return ids.size === items.length && items.every((i) => ids.has(i.id));
}

type LedgerEntry = { taskEventIds: string[]; at: number; rules: string[] };

/** The recheck hold's reason, naming what the draft was flagged for. */
function recheckReason(rules: readonly string[]): string {
  const flagged: string[] = [];
  if (rules.includes(BAND_RULES.ungrounded) || rules.includes(BAND_RULES.unneeded)) flagged.push('unverified statements');
  if (rules.includes(BAND_RULES.pii)) flagged.push('personal details');
  if (rules.includes(BAND_RULES.token)) flagged.push('a redaction placeholder');
  return `Held for the principal: it was flagged for ${flagged.length > 0 ? flagged.join(' and ') : 'unverified statements'}, and the reviewer was unavailable to recheck it.`;
}

function containsFolded(haystack: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return n.length > 0 && haystack.toLowerCase().includes(n);
}

/** Either text contains the other, ignoring case. */
function overlaps(a: string, b: string): boolean {
  return containsFolded(a, b) || containsFolded(b, a);
}
