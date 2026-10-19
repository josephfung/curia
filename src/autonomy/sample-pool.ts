// sample-pool.ts — which autonomous actions the principal may be asked to spot-check (#2159 Phase 3).
//
// Pool rows are ordinary autonomy_action_log rows with outcome 'success'. They are written
// with scored_by = 'sample-pool' so the nightly LLM judge (findUnscoredTerminal) never grades
// them, and with every flag null so the scorer ignores them until the principal gives a
// verdict. Only the principal's verdict scores a sampled action (decision of 2026-10-19).

import { AutonomyService } from './autonomy-service.js';
import { HUMAN_SEND_SKILLS } from './band-policy.js';
import type { ActionRisk } from '../skills/types.js';
import { sanitizeDisplayName, sanitizeOutput } from '../skills/sanitize.js';

export const SAMPLE_POOL_SCORED_BY = 'sample-pool';
export const PRINCIPAL_SCORED_BY = 'principal';

/**
 * Mail triage: archiving or labelling the principal's mail. Sampled at any risk.
 *
 * Not ceo-inbox-update-folders: ceo-inbox triage calls it AND ceo-inbox-archive for the same
 * message, so sampling both turned one triage decision into two pool rows. It is low risk,
 * so outside this set it is not sampled at all.
 */
export const TRIAGE_SKILLS: ReadonlySet<string> = new Set([
  'ceo-inbox-archive', 'ceo-inbox-label', 'email-archive', 'email-label',
]);

// Medium-risk tools that would only add noise to the pool.
const NOT_SAMPLED: ReadonlySet<string> = new Set([
  // No effect outside Curia: reading a file is not an action to check.
  'file-parse',
  // One browsing task makes many calls (navigate, click, read), which would flood the pool
  // with steps of a single action. TODO: revisit once a form submission is distinguishable
  // from navigation, since a submission is worth spot-checking.
  'web-browser',
  // Only queues a writing-voice proposal; the principal approves it before anything changes.
  'voice-learn',
]);

// The gateway records every send (skill or relay) with the review's signals; the
// execution layer must not record them a second time.
const RECORDED_BY_GATEWAY: ReadonlySet<string> = new Set([...HUMAN_SEND_SKILLS, 'dispatcher-relay']);

export interface SampleSignals {
  /** Band review said the send speaks for the principal. */
  speaksAsPrincipal?: boolean;
  /** No contact existed for the recipient at send time. */
  firstContact?: boolean;
  review?: 'bounced' | 'trimmed' | 'unreviewed';
  /** Band Gate C let it through where the tier would have asked. */
  gateProceeded?: boolean;
  triage?: boolean;
}

export interface SampledActionInsert {
  taskId: string;
  conversationId?: string;
  toolName: string;
  actionRisk: string;
  /** What the principal reads in the spot check, e.g. 'Emailed dana@example.com: "Re: Payment schedule"'. */
  summary: string;
  signals: SampleSignals;
  /** The tool's input, kept on the row when its JSON is at most 2000 characters. */
  input?: Record<string, unknown>;
  /**
   * Subject and sender of the email a triage action touched, when the tool's result carried
   * them. Stored under payload.sample.email so the sampler knows the row is already readable
   * and skips its mail lookup.
   */
  email?: SampleEmail;
}

/** The part of an email a principal needs to grade a triage action. */
export interface SampleEmail {
  subject?: string;
  from?: string;
}

/** An enriched triage summary stays short enough to read on a phone. */
export const ENRICHED_SUMMARY_MAX = 120;
/** Each stored email field is bounded so a hostile or huge subject cannot bloat the row. */
const SAMPLE_EMAIL_FIELD_MAX = 200;

/** Collapse any run of whitespace (line breaks included) to one space: each sample is one numbered line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function capText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// ── Untrusted email text ────────────────────────────────────────────────────
//
// A subject and a sender name are written by whoever sent the email. They land in the
// principal's digest (rendered as markdown or HTML by some channels) and in the context of the
// agent composing it. So before either goes into a summary line: tags are stripped and secret
// patterns redacted, and the characters that build a markdown link or an HTML tag are swapped
// for parentheses, so `[Renew](https://evil.example)` can never render as a link. Every path
// into a summary (write time in the execution layer, draw-time lookup in the sampler) goes
// through formatEmailSummary or sampleEmailFromResult, so this is the one place it happens.
//
// Entities: sanitizeOutput decodes one level of HTML entities per call, and the tool result is
// decoded again by sanitizeObjectOutput on its way to the agent. So `&amp;#91;` cleaned once
// would become `&#91;`, and then `[` downstream, AFTER neutralization. The cleaner therefore
// decodes to a fixed point first (see fullyDecoded) and, after neutralizing, defuses any `&`
// that could still start an entity, so a later decode has nothing left to turn into markup.

/**
 * A bare address. Excludes every character that could carry markup or break the line,
 * including `&` and `#`, so an entity-encoded address (`&#60b&#62x@…`) is never kept as one.
 */
const BARE_ADDRESS = /^[^\s@<>()[\]"',;:\\&#]+@[^\s@<>()[\]"',;:\\&#]+$/;

/**
 * Upper bound on sanitizeOutput passes. Each pass decodes one entity level and only shrinks or
 * keeps the string, so it reaches a fixed point quickly; the cap only bounds the work on a
 * pathologically nested input. Anything still encoded past it is defused by defuseEntities.
 */
const MAX_DECODE_PASSES = 5;

/**
 * Split `Name <address>` (legacy rows, provider strings) or `Name (address)` (describeMessage),
 * or null when the line does not end in a bracketed plain address. Index-based rather than a
 * regex so a long hostile name cannot make the parse backtrack.
 */
function splitNamedAddress(line: string): { name: string; address: string } | null {
  const close = line.at(-1);
  if (close !== '>' && close !== ')') return null;
  const open = line.lastIndexOf(close === '>' ? '<' : '(');
  if (open < 0) return null;
  const address = line.slice(open + 1, -1).trim();
  return BARE_ADDRESS.test(address) ? { name: line.slice(0, open), address } : null;
}

/** Swap the characters that build a markdown link or an HTML tag for parentheses. */
function neutralizeMarkup(s: string): string {
  return s.replace(/[[<]/g, '(').replace(/[\]>]/g, ')');
}

/**
 * sanitizeOutput (tag strip, secret redaction, one entity level decoded) repeated until the
 * string stops changing, so every encoded level is decoded, and then stripped if it was a tag.
 */
function fullyDecoded(raw: string): string {
  let text = raw;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    const next = sanitizeOutput(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Break every `&` that could begin an entity by putting a space after it, so no later decode
 * can produce markup from it: a numeric one (`&#91;`), a named one (`&lbrack;`), or one of the
 * legacy names a decoder accepts without the semicolon that matter here (`&lt`, `&gt`, `&amp`,
 * `&quot`). A plain `Q&A` is not an entity and keeps reading as written.
 */
function defuseEntities(s: string): string {
  return s.replace(/&(?=#|[a-z][a-z0-9]*;|lt|gt|amp|quot)/gi, '& ');
}

/** A subject made safe to show: tags stripped, secrets redacted, no link, tag or entity left. */
function cleanSubject(raw: string): string {
  return oneLine(defuseEntities(neutralizeMarkup(fullyDecoded(raw))));
}

/** A sender name through the display-name allowlist (which drops brackets, colons, slashes). */
function cleanName(raw: string): string {
  if (!raw.trim()) return '';
  // Decode every entity level first, so an encoded link or tag is seen (and dropped) for what
  // it is. A name has no business carrying a URL: drop a markdown link's target, keep its text.
  // The display-name allowlist then drops `&`, `#` and `;`, so no entity survives.
  const name = sanitizeDisplayName(fullyDecoded(raw).replace(/\]\([^)]*\)/g, ']'));
  // sanitizeDisplayName's last resort for a name that sanitizes to nothing is the literal
  // 'Unknown'. Beside an address, showing nothing is better than inventing a name.
  return name === 'Unknown' && !/unknown/i.test(raw) ? '' : name;
}

/**
 * A sender made safe to show, as `Name (address)`, the bare address, or the name alone. The
 * address stays readable (the principal grades by it) but is kept only when it is a plain
 * address with no markup characters; anything else is treated as part of the name.
 */
function cleanSender(raw: string): string {
  const line = oneLine(raw);
  if (BARE_ADDRESS.test(line)) return line;
  const named = splitNamedAddress(line);
  const name = cleanName(named ? named.name : line);
  const address = named?.address ?? '';
  if (name && address) return `${name} (${address})`;
  return name || address;
}

/**
 * The summary line for a triage sample once the email is known:
 * `Archive an email: "Statement ready" from Billing (billing@example.com)`.
 *
 * Returns the base (as one line) when there is no subject or sender to add. One helper for
 * the execution layer (write time) and the sampler (draw-time lookup) so the two cannot drift.
 * The subject and sender are untrusted and cleaned here (see "Untrusted email text" above).
 */
export function formatEmailSummary(base: string, subject?: string, from?: string): string {
  const cleanBase = oneLine(base);
  const s = subject ? cleanSubject(subject) : '';
  const f = from ? cleanSender(from) : '';
  if (!s && !f) return cleanBase;
  const detail = [s ? `"${s}"` : '', f ? `from ${f}` : ''].filter(Boolean).join(' ');
  return capText(`${cleanBase}: ${detail}`, ENRICHED_SUMMARY_MAX);
}

/**
 * Pull the subject/sender out of a tool result's data, or undefined when it has neither.
 * Anything that is not a non-empty string is ignored: tool output is untyped. Both are
 * cleaned before they are stored (see "Untrusted email text" above), so the row never holds
 * a link or markup even if a later reader skips formatEmailSummary.
 */
export function sampleEmailFromResult(data: unknown): SampleEmail | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  const field = (v: unknown, clean: (raw: string) => string): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = clean(v);
    return t ? capText(t, SAMPLE_EMAIL_FIELD_MAX) : undefined;
  };
  const subject = field(rec['subject'], cleanSubject);
  const from = field(rec['from'], cleanSender);
  if (!subject && !from) return undefined;
  return { ...(subject ? { subject } : {}), ...(from ? { from } : {}) };
}

/** Whether the execution layer records a successful autonomous call of this tool in the pool. */
export function isSampledTool(toolName: string, actionRisk: ActionRisk): boolean {
  if (RECORDED_BY_GATEWAY.has(toolName) || NOT_SAMPLED.has(toolName)) return false;
  if (TRIAGE_SKILLS.has(toolName)) return true;
  return AutonomyService.minScoreForActionRisk(actionRisk) >= AutonomyService.minScoreForActionRisk('medium');
}

/**
 * High (3): what the spec asks to check most. Low (1): routine logistics. Never zero.
 *
 * Weights are relative, so the 3:1 ratio is what matters. Routine actions keep a weight of 1
 * rather than 0: a zero-weight candidate is only ever chosen once nothing else is left, so
 * a zero would shut routine actions out of the sample almost entirely.
 */
export function sampleWeight(signals: SampleSignals): number {
  const high = signals.speaksAsPrincipal === true || signals.firstContact === true
    || signals.review !== undefined || signals.gateProceeded === true || signals.triage === true;
  return high ? 3 : 1;
}

/**
 * Weighted random selection without replacement. `random` is injected so tests can seed it.
 *
 * Each pick removes the chosen candidate before the next draw, so a heavy candidate cannot
 * be picked twice. The floor on weights (Number.MIN_VALUE) keeps a non-positive weight from
 * dropping a candidate out of the draw.
 */
export function selectSamples<T>(candidates: readonly T[], weightOf: (c: T) => number, cap: number, random: () => number): T[] {
  const pool = candidates.map((c) => ({ c, w: Math.max(weightOf(c), Number.MIN_VALUE) }));
  const picked: T[] = [];
  while (picked.length < cap && pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0);
    let r = random() * total;
    let i = 0;
    while (i < pool.length - 1 && r >= pool[i]!.w) { r -= pool[i]!.w; i++; }
    picked.push(pool[i]!.c);
    pool.splice(i, 1);
  }
  return picked;
}
