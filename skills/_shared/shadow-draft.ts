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

/**
 * Decision/outcome equivalence — not phrasing.
 * High overlap of content tokens OR shared commitment verbs/dates → match.
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

  const commitRe =
    /\b(will|shall|confirm|confirmed|agree|agreed|schedule|scheduled|send|sent|approve|approved|decline|declined|accept|accepted)\b/i;
  const shadowCommit = commitRe.test(shadowBody);
  const sentCommit = commitRe.test(sentBody);
  const commitAlign = shadowCommit === sentCommit;

  // Dates / numbers alignment (rough commitment signal).
  const nums = (s: string) => new Set(s.match(/\b\d{1,4}\b/g) ?? []);
  const shadowNums = nums(shadowBody);
  const sentNums = nums(sentBody);
  let numHit = 0;
  for (const n of shadowNums) if (sentNums.has(n)) numHit += 1;
  const numAlign = shadowNums.size === 0 || numHit > 0;

  if (jaccard >= 0.35 && commitAlign) {
    return { competenceFlag: 1, reason: `jaccard=${jaccard.toFixed(2)}+commit-align` };
  }
  if (jaccard >= 0.25 && commitAlign && numAlign) {
    return { competenceFlag: 1, reason: `jaccard=${jaccard.toFixed(2)}+commit+nums` };
  }
  return { competenceFlag: 0, reason: `jaccard=${jaccard.toFixed(2)};commitAlign=${commitAlign}` };
}
