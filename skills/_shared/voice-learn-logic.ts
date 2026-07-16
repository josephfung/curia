// Pure voice-learning logic (#1419) — deterministic diff parsing + LLM guide prompt builder.
// The heuristic scoring engine (thresholds, provenance, auto/propose lanes) was replaced by a
// weekly LLM pass; see #1423 history for the old design if it needs to be resurrected.

export interface ParsedDiffPair {
  draftId: string;
  messageId: string;
  sentAt: string;
  subject: string;
  draftBody: string;
  sentBody: string;
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

/**
 * Build the prompt for the weekly LLM voice-learning pass: given the current voice guide and
 * the parsed (draft, sent) diff pairs since the last run, ask the model to return an updated
 * guide. Replaces the old heuristic scoring/threshold machinery — the LLM now does the
 * inference over tone, phrasing, structure, etc. directly from the raw diffs.
 */
export function buildVoiceGuidePrompt(currentGuide: string, pairs: ParsedDiffPair[]): string {
  const diffs = pairs
    .map(
      (p, i) =>
        `### Edit ${i + 1}\nDRAFT (assistant wrote):\n${p.draftBody.trim()}\n\nSENT (CEO actually sent):\n${p.sentBody.trim()}`,
    )
    .join('\n\n---\n\n');
  return [
    'You maintain a short guide describing how a specific CEO writes email, used to steer an',
    'assistant that drafts on their behalf. Below are recent cases where the assistant drafted',
    'and the CEO edited before sending. Infer how the CEO writes — tone, directness, humour,',
    'greetings/sign-off, formatting, structure, length, phrasing they add or cut.',
    '',
    'Current guide (may be empty):',
    currentGuide.trim() || '(none yet)',
    '',
    'Return an UPDATED guide as concise markdown bullet guidance (no preamble). Fold in the new',
    'evidence; keep still-valid points; drop nothing without reason. Focus on durable, general',
    'patterns, not one-off wording.',
    '',
    '## Recent edits',
    diffs,
  ].join('\n');
}
