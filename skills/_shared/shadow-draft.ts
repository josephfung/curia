// Shadow-draft capture + batched LLM judge prompt/parse (#1426 / #1419 / ADR-029).

import { VOICE_LEARNING_SCRATCH_PREFIX } from './voice-learning-capture.js';

export const SHADOW_DOC_TYPE = 'shadow-draft';
export const SHADOW_SCRATCH_PREFIX = `${VOICE_LEARNING_SCRATCH_PREFIX}/shadow`;

export function shadowDraftPath(sourceMessageId: string): string {
  return `${SHADOW_SCRATCH_PREFIX}/${sourceMessageId}.md`;
}

export interface ShadowSnapshot {
  sourceMessageId: string;
  threadId: string;
  subject: string;
  recipients: string[];
  body: string;
  createdAt: string;
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
  };
}

export interface ShadowJudgePair {
  sourceMessageId: string;
  subject: string;
  shadowBody: string;
  sentBody: string;
}

export interface ShadowJudgement {
  sourceMessageId: string;
  sameDecision: boolean;
  reason: string;
}

/** Build one prompt that judges substantive decision equivalence for a batch of pairs. */
export function buildShadowJudgePrompt(pairs: ShadowJudgePair[]): string {
  const items = pairs
    .map(
      (p, i) =>
        `### Pair ${i + 1} (source_message_id: ${p.sourceMessageId})\n` +
        `Subject: ${p.subject}\n\n` +
        `SHADOW (what the assistant would have sent):\n${p.shadowBody.trim() || '(empty)'}\n\n` +
        `ACTUAL (what the CEO actually sent):\n${p.sentBody.trim() || '(empty)'}`,
    )
    .join('\n\n---\n\n');
  return [
    'You are auditing an AI assistant against a CEO. For each pair, decide whether the',
    'SHADOW email reaches the SAME substantive decision / recommendation / outcome as the',
    'ACTUAL email — e.g. proposes the same meeting time, gives the same answer to a policy',
    'question, makes the same ask, reports the same status. Judge the decision, NOT wording,',
    'tone, or length. Opposing or materially different decisions are not the same.',
    '',
    'Return ONLY a JSON array, one object per pair:',
    '[{"source_message_id": "...", "same_decision": true|false, "reason": "<short>"}]',
    '',
    items,
  ].join('\n');
}

/** Tolerant parse of the judge output — extracts the first JSON array, keeps well-formed entries. */
export function parseShadowJudgeResult(text: string): ShadowJudgement[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ShadowJudgement[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.source_message_id !== 'string' || typeof r.same_decision !== 'boolean') continue;
    out.push({
      sourceMessageId: r.source_message_id,
      sameDecision: r.same_decision,
      reason: typeof r.reason === 'string' ? r.reason : '',
    });
  }
  return out;
}
