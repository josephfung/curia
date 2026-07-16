// Shadow-draft capture + decision-equivalence scoring (#1426 / ADR-029).

import { VOICE_LEARNING_SCRATCH_PREFIX } from './voice-learning-capture.js';
import { tokenize } from './sent-observe-match.js';

export const SHADOW_DOC_TYPE = 'shadow-draft';
export const SHADOW_SCRATCH_PREFIX = `${VOICE_LEARNING_SCRATCH_PREFIX}/shadow`;

/** High-sensitivity capture exclusions (board / investors / legal / spouse). */
const SENSITIVE_RE =
  /\b(board|investor|investors|legal|counsel|attorney|spouse|wife|husband|partner\b.*personal|nda|privileged)\b/i;

export function shadowDraftPath(sourceMessageId: string): string {
  return `${SHADOW_SCRATCH_PREFIX}/${sourceMessageId}.md`;
}

export function isHighSensitivityThread(params: {
  subject: string;
  body?: string;
  from?: string;
  labels?: string[];
}): boolean {
  const hay = [params.subject, params.body ?? '', params.from ?? '', ...(params.labels ?? [])].join(
    ' ',
  );
  return SENSITIVE_RE.test(hay);
}

export interface ShadowSnapshot {
  sourceMessageId: string;
  threadId: string;
  subject: string;
  recipients: string[];
  body: string;
  createdAt: string;
  disposition: string;
}

export function parseShadowDoc(doc: {
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): ShadowSnapshot | null {
  if (doc.type !== SHADOW_DOC_TYPE) return null;
  const fm = doc.frontmatter;
  const sourceMessageId = typeof fm.source_message_id === 'string' ? fm.source_message_id : '';
  if (!sourceMessageId) return null;
  if (fm.reconciled_at) return null; // already scored
  return {
    sourceMessageId,
    threadId: typeof fm.thread_id === 'string' ? fm.thread_id : '',
    subject: typeof fm.subject === 'string' ? fm.subject : '',
    recipients: Array.isArray(fm.recipients)
      ? fm.recipients.filter((r): r is string => typeof r === 'string')
      : [],
    body: doc.body,
    createdAt: typeof fm.created_at === 'string' ? fm.created_at : '',
    disposition: typeof fm.disposition === 'string' ? fm.disposition : 'punt',
  };
}

export type DecisionPolarity = 'affirm' | 'deny' | 'none';

// Deny is checked first so "cannot approve" / "won't accept" read as denials.
const DENY_RE =
  /\b(decline|declined|reject|rejected|refuse|refused|won'?t|cannot|can'?t|unable|deny|denied|not\s+(?:able|going|proceeding|approv\w*|accept\w*))\b/i;
const AFFIRM_RE =
  /\b(approve|approved|agree|agreed|accept|accepted|confirm|confirmed|will|shall|yes|happy\s+to|glad\s+to|sounds\s+good|go\s+ahead)\b/i;

/** Classify the decision a message expresses. Deny wins ties ("cannot approve" = deny). */
export function detectDecisionPolarity(body: string): DecisionPolarity {
  if (DENY_RE.test(body)) return 'deny';
  if (AFFIRM_RE.test(body)) return 'affirm';
  return 'none';
}

/**
 * Decision/outcome equivalence — did the shadow reach the SAME decision as the actual
 * send, not merely share vocabulary. This flag feeds the autonomy score, so it fails
 * safe (toward 0): a false 1 would inflate autonomy on evidence Curia didn't earn.
 *
 * - Opposing decisions (approve vs decline) never count, however much text they share.
 * - A decision on one side but not the other is not equivalence.
 * - Aligned decisions credit on modest content overlap; two purely informational
 *   replies credit only on strong overlap.
 */
export function scoreDecisionEquivalence(
  shadowBody: string,
  sentBody: string,
): { competenceFlag: 0 | 1; reason: string } {
  const shadowTokens = tokenize(shadowBody);
  const sentTokens = tokenize(sentBody);
  if (shadowTokens.size === 0 || sentTokens.size === 0) {
    return { competenceFlag: 0, reason: 'empty-body' };
  }

  let inter = 0;
  for (const t of shadowTokens) if (sentTokens.has(t)) inter += 1;
  const union = shadowTokens.size + sentTokens.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;

  const shadowPol = detectDecisionPolarity(shadowBody);
  const sentPol = detectDecisionPolarity(sentBody);

  // Opposing decisions are the clearest form of divergence — reject outright.
  if (
    (shadowPol === 'affirm' && sentPol === 'deny') ||
    (shadowPol === 'deny' && sentPol === 'affirm')
  ) {
    return { competenceFlag: 0, reason: `decision-diverged(${shadowPol}!=${sentPol})` };
  }
  // One side committed to a decision, the other stayed silent — not the same decision.
  if ((shadowPol === 'none') !== (sentPol === 'none')) {
    return { competenceFlag: 0, reason: `decision-asymmetry(${shadowPol}/${sentPol})` };
  }

  // Dates / numbers alignment (rough commitment signal).
  const nums = (s: string) => new Set(s.match(/\b\d{1,4}\b/g) ?? []);
  const shadowNums = nums(shadowBody);
  const sentNums = nums(sentBody);
  let numHit = 0;
  for (const n of shadowNums) if (sentNums.has(n)) numHit += 1;
  const numAlign = shadowNums.size === 0 || numHit > 0;

  if (shadowPol !== 'none') {
    // Both reached the same decision polarity — credit on modest content overlap.
    if (jaccard >= 0.25 && numAlign) {
      return { competenceFlag: 1, reason: `${shadowPol}-aligned;jaccard=${jaccard.toFixed(2)}` };
    }
    return { competenceFlag: 0, reason: `${shadowPol}-aligned;low-overlap;jaccard=${jaccard.toFixed(2)}` };
  }

  // Both purely informational (no explicit decision) — demand strong equivalence.
  if (jaccard >= 0.4 && numAlign) {
    return { competenceFlag: 1, reason: `informational-equiv;jaccard=${jaccard.toFixed(2)}` };
  }
  return { competenceFlag: 0, reason: `no-decision;jaccard=${jaccard.toFixed(2)}` };
}
