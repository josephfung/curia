// Pure voice-learning logic (#1423) — thresholds, provenance, auto vs propose lanes.

export type VoiceFieldProvenance = 'seeded' | 'learned' | 'operator-set';

export type VoiceField =
  | 'tone'
  | 'formality'
  | 'patterns'
  | 'vocabulary'
  | 'signOff';

export interface VoiceProvenanceMap {
  tone: VoiceFieldProvenance;
  formality: VoiceFieldProvenance;
  patterns: VoiceFieldProvenance;
  vocabulary: VoiceFieldProvenance;
  signOff: VoiceFieldProvenance;
}

export const DEFAULT_PROVENANCE: VoiceProvenanceMap = {
  tone: 'seeded',
  formality: 'seeded',
  patterns: 'seeded',
  vocabulary: 'seeded',
  signOff: 'seeded',
};

/** Design §7.2 thresholds. */
export const THRESHOLDS = {
  vocabulary: { minPairs: 3, consistency: 0.7, lane: 'auto' as const },
  signOff: { minPairs: 3, consistency: 0.7, lane: 'propose' as const },
  patterns: { minPairs: 5, consistency: 0.6, lane: 'propose' as const },
  formality: { minPairs: 8, meanDelta: 10, lane: 'propose' as const },
};

export interface ParsedDiffPair {
  draftId: string;
  messageId: string;
  sentAt: string;
  subject: string;
  draftBody: string;
  sentBody: string;
}

export interface VoiceDelta {
  field: VoiceField;
  /** Human-readable description of the change. */
  description: string;
  /** Patch fragment for WritingVoice (snake_case for skill input where needed). */
  patch: Record<string, unknown>;
  /** Number of qualifying pairs supporting this delta. */
  sampleCount: number;
  consistency: number;
  magnitude: 'low' | 'high';
}

export interface ApplyDecision {
  delta: VoiceDelta;
  action: 'auto' | 'propose' | 'skip';
  reason: string;
}

/** Parse rolling pending-diffs.md into (draft, sent) pairs. */
export function parsePendingDiffs(body: string): ParsedDiffPair[] {
  const pairs: ParsedDiffPair[] = [];
  const sections = body.split(/^## Diff — /m).slice(1);
  for (const section of sections) {
    const header = section.split('\n')[0] ?? '';
    const draftMatch = header.match(/draft\s+(\S+)\s*↔\s*sent\s+(\S+)/);
    if (!draftMatch) continue;
    const draftId = draftMatch[1]!;
    const messageId = draftMatch[2]!;
    const sentAt = (section.match(/- sent_at:\s*(.+)/)?.[1] ?? '').trim();
    const subject = (section.match(/- subject:\s*(.+)/)?.[1] ?? '').trim();
    const draftBody = extractSection(section, '### Draft', '### Sent');
    // Use the LAST `---` in the block as the sent terminator: formatDiffBlock closes each
    // block with `---`, but a sent email can legitimately contain its own `---` line
    // (markdown rule / signature). Matching the first would truncate the body mid-email.
    const sentBody = extractSection(section, '### Sent', '---', { fromEnd: true });
    if (!draftBody.trim() && !sentBody.trim()) continue;
    // Exclude verbatim sends (no signal) and near-total rewrites.
    if (isVerbatim(draftBody, sentBody) || isNearTotalRewrite(draftBody, sentBody)) continue;
    pairs.push({ draftId, messageId, sentAt, subject, draftBody, sentBody });
  }
  return pairs;
}

function extractSection(
  text: string,
  start: string,
  end: string,
  opts: { fromEnd?: boolean } = {},
): string {
  const s = text.indexOf(start);
  if (s < 0) return '';
  const after = text.slice(s + start.length);
  const re = new RegExp(`^${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm');
  let cut = -1;
  for (let m = re.exec(after); m; m = re.exec(after)) {
    cut = m.index;
    if (!opts.fromEnd) break; // first match unless the caller wants the last delimiter
  }
  return (cut < 0 ? after : after.slice(0, cut)).trim();
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isVerbatim(draft: string, sent: string): boolean {
  return normalizeWs(draft) === normalizeWs(sent);
}

function isNearTotalRewrite(draft: string, sent: string): boolean {
  const d = normalizeWs(draft);
  const s = normalizeWs(sent);
  if (!d || !s) return false;
  // Measure whole-content overlap, not shared prefix: an unrelated rewrite of similar
  // length has a long common prefix ratio near 0 but the old length heuristic let it
  // through. Token Jaccard catches "different email entirely" regardless of length.
  const dt = new Set(d.split(' ').filter(Boolean));
  const st = new Set(s.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of dt) if (st.has(t)) inter += 1;
  const union = dt.size + st.size - inter;
  const overlap = union === 0 ? 0 : inter / union;
  // Near-total rewrite = almost no shared vocabulary. Draft→sent edits that keep the
  // email's substance stay well above this floor and remain valid learning signal.
  return overlap < 0.15;
}

/** Extract a trailing sign-off from a body (last short line, or trailing clause). */
export function extractSignOff(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1]!;
  // Prefer a dedicated short last line.
  if (last.length <= 40 && !/[.!?]$/.test(last) && !last.includes('@') && !last.includes(',')) {
    return last;
  }
  // Fall back: trailing clause after the final comma/dash ("…, Thanks" / "— Thanks").
  const trailing = last.match(/(?:,|—|-)\s*([A-Za-z][A-Za-z\s']{0,30})$/);
  if (trailing?.[1]) {
    const candidate = trailing[1].trim();
    if (candidate.length <= 40 && !/[.!?]$/.test(candidate)) return candidate;
  }
  return null;
}

/** Heuristic vocabulary signals: words removed from draft→sent → avoid; words added → prefer. */
export function extractVocabularySignals(pairs: ParsedDiffPair[]): {
  prefer: Map<string, number>;
  avoid: Map<string, number>;
} {
  const prefer = new Map<string, number>();
  const avoid = new Map<string, number>();
  for (const p of pairs) {
    const draftWords = wordSet(p.draftBody);
    const sentWords = wordSet(p.sentBody);
    for (const w of draftWords) {
      if (!sentWords.has(w)) avoid.set(w, (avoid.get(w) ?? 0) + 1);
    }
    for (const w of sentWords) {
      if (!draftWords.has(w)) prefer.set(w, (prefer.get(w) ?? 0) + 1);
    }
  }
  return { prefer, avoid };
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

export function meanLengthDelta(pairs: ParsedDiffPair[]): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const p of pairs) {
    const d = p.draftBody.length || 1;
    sum += ((p.sentBody.length - d) / d) * 100;
  }
  return sum / pairs.length;
}

/** Build candidate deltas from parsed pairs (heuristic, no LLM). */
export function proposeDeltasFromPairs(pairs: ParsedDiffPair[]): VoiceDelta[] {
  const deltas: VoiceDelta[] = [];
  if (pairs.length === 0) return deltas;

  // Sign-off
  const signOffCounts = new Map<string, number>();
  for (const p of pairs) {
    const so = extractSignOff(p.sentBody);
    if (so) signOffCounts.set(so, (signOffCounts.get(so) ?? 0) + 1);
  }
  let topSignOff: string | null = null;
  let topSignOffCount = 0;
  for (const [so, n] of signOffCounts) {
    if (n > topSignOffCount) {
      topSignOff = so;
      topSignOffCount = n;
    }
  }
  if (topSignOff) {
    deltas.push({
      field: 'signOff',
      description: `Prefer sign-off "${topSignOff}"`,
      patch: { sign_off: topSignOff },
      sampleCount: topSignOffCount,
      consistency: topSignOffCount / pairs.length,
      magnitude: 'low',
    });
  }

  // Vocabulary
  const { prefer, avoid } = extractVocabularySignals(pairs);
  const preferHits = [...prefer.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const avoidHits = [...avoid.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (preferHits.length > 0 || avoidHits.length > 0) {
    const support = Math.max(
      ...preferHits.map(([, n]) => n),
      ...avoidHits.map(([, n]) => n),
      0,
    );
    deltas.push({
      field: 'vocabulary',
      description: `Vocabulary prefer=[${preferHits.map(([w]) => w).join(', ')}] avoid=[${avoidHits.map(([w]) => w).join(', ')}]`,
      patch: {
        vocabulary: {
          prefer: preferHits.map(([w]) => w),
          avoid: avoidHits.map(([w]) => w),
        },
      },
      sampleCount: support,
      consistency: support / pairs.length,
      magnitude: 'low',
    });
  }

  // Formality from length delta (shorter → lower formality heuristic)
  const lenDelta = meanLengthDelta(pairs);
  if (Math.abs(lenDelta) >= 10) {
    deltas.push({
      field: 'formality',
      description: `Mean length delta ${lenDelta.toFixed(0)}% suggests formality shift`,
      patch: { formality_delta: Math.round(lenDelta > 0 ? 10 : -10) },
      sampleCount: pairs.length,
      consistency: 1,
      magnitude: 'high',
    });
  }

  return deltas;
}

/**
 * Decide auto vs propose vs skip per design §7.2 + provenance.
 * Tone always proposes. Operator-set never auto. Seeded empties can auto-fill.
 */
export function decideApplication(
  delta: VoiceDelta,
  provenance: VoiceProvenanceMap,
  opts: {
    currentSignOffEmpty: boolean;
    currentVocabularyEmpty: boolean;
    dismissedDimensions: Set<string>;
  },
): ApplyDecision {
  if (opts.dismissedDimensions.has(delta.field)) {
    return { delta, action: 'skip', reason: 'dismissed-cooldown' };
  }

  if (delta.field === 'tone') {
    return { delta, action: 'propose', reason: 'tone-always-proposes' };
  }

  const prov = provenance[delta.field];
  if (prov === 'operator-set') {
    return { delta, action: 'propose', reason: 'operator-set-field' };
  }

  if (delta.field === 'vocabulary') {
    const t = THRESHOLDS.vocabulary;
    if (delta.sampleCount >= t.minPairs && delta.consistency >= t.consistency && delta.magnitude === 'low') {
      return { delta, action: 'auto', reason: 'vocabulary-threshold-met' };
    }
    if (opts.currentVocabularyEmpty && delta.sampleCount >= t.minPairs) {
      return { delta, action: 'auto', reason: 'seeded-empty-vocabulary-fill' };
    }
    return { delta, action: 'propose', reason: 'below-vocabulary-threshold' };
  }

  if (delta.field === 'signOff') {
    const t = THRESHOLDS.signOff;
    if (opts.currentSignOffEmpty && delta.sampleCount >= t.minPairs && delta.consistency >= t.consistency) {
      return { delta, action: 'auto', reason: 'seeded-empty-signoff-fill' };
    }
    if (delta.sampleCount >= t.minPairs) {
      return { delta, action: 'propose', reason: 'signoff-propose-lane' };
    }
    return { delta, action: 'skip', reason: 'below-signoff-threshold' };
  }

  if (delta.field === 'patterns') {
    const t = THRESHOLDS.patterns;
    if (delta.sampleCount >= t.minPairs && delta.consistency >= t.consistency) {
      return { delta, action: 'propose', reason: 'patterns-propose-lane' };
    }
    return { delta, action: 'skip', reason: 'below-patterns-threshold' };
  }

  if (delta.field === 'formality') {
    const t = THRESHOLDS.formality;
    if (delta.sampleCount >= t.minPairs) {
      return { delta, action: 'propose', reason: 'formality-propose-lane' };
    }
    return { delta, action: 'skip', reason: 'below-formality-threshold' };
  }

  return { delta, action: 'propose', reason: 'default-propose' };
}

export function isNearDefaultProfile(voice: {
  tone: string[];
  formality: number;
  patterns: string[];
  vocabulary: { prefer: string[]; avoid: string[] };
  signOff: string;
}): boolean {
  return (
    voice.signOff.trim() === '' &&
    voice.vocabulary.prefer.length === 0 &&
    voice.vocabulary.avoid.length === 0 &&
    voice.formality === 50 &&
    voice.patterns.length <= 2
  );
}

export function formatProposalBlock(decision: ApplyDecision): string {
  const d = decision.delta;
  return [
    '',
    `## Proposal — ${d.field}`,
    '',
    `- status: pending`,
    `- action_lane: ${decision.action}`,
    `- reason: ${decision.reason}`,
    `- description: ${d.description}`,
    `- sample_count: ${d.sampleCount}`,
    `- consistency: ${d.consistency.toFixed(2)}`,
    `- magnitude: ${d.magnitude}`,
    `- patch: ${JSON.stringify(d.patch)}`,
    '',
    '---',
    '',
  ].join('\n');
}
