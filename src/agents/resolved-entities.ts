// resolved-entities.ts — parse, bound, and check conversation identity (#1818).
//
// A `<resolved_entities>` block lives in a specialist's reply. Output
// sanitization strips those tags before the coordinator's next turn, and
// working memory never stores tool results, so the contact IDs would otherwise
// vanish. Callers persist the IDs (not the snapshot text) and re-render a
// fresh block from the current contact row.

/** Contact IDs captured from a specialist reply. UUID form, lowercase. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many most-recent contacts a turn will re-inject. */
export const MAX_RESOLVED_ENTITIES = 12;

/** Hard character cap on the re-injected block, independent of the token budget. */
export const RESOLVED_ENTITIES_MAX_CHARS = 2_400;

/** context.budget tier name for the re-injected block. */
export const RESOLVED_ENTITIES_TIER = 'resolved_entities';

const BLOCK_RE = /<resolved_entities\b[^>]*>([\s\S]*?)<\/resolved_entities>/gi;
const CONTACT_RE = /<contact\b([^>]*?)\/?>/gi;
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Horizontal whitespace only. `\s` would glue "Xiaopu Chen\nWill" into one
// mention, and a covered person plus the next line's name would then look
// unresolved. `\b` is ASCII-only, so boundaries are Unicode-aware lookarounds.
const LATIN_WORD = String.raw`\p{Lu}[\p{Ll}\p{M}]*(?:['’-][\p{Lu}\p{Ll}\p{M}]+)?`;
const NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${LATIN_WORD}(?:[ \t]+${LATIN_WORD}){0,2}(?![\p{L}\p{N}_])`,
  'gu',
);
/** Han (and other) names have no case and no ASCII word boundary. */
const CJK_NAME_RE = /(?<![\p{L}\p{N}])\p{Lo}{2,4}(?![\p{L}\p{N}])/gu;

/**
 * A capitalized span is a person only when one of these sits nearby. Bare
 * Title Case ("Quarterly Planning Session", "Google Drive", "Zoom") is not.
 */
const PERSON_CUE_RE = /(?<![\p{L}\p{N}])(?:invit(?:e|es|ed|ing)|register(?:s|ed|ing)?|guests?|attendees?|attend(?:s|ed|ing)?|rsvp|behalf|named|called)(?![\p{L}\p{N}])|(?:^|[ \t])(?:Mr|Mrs|Ms|Dr|Prof)\.?(?=[ \t]|$)/iu;

/**
 * Explicit "we do not actually know who this is" hedges. Sending one of these
 * to an external recipient is the failure mode in #1818 — the model reporting
 * its own missing context as if it were a fact.
 */
const HEDGE_RE = /\b(?:last name|surname|full name)\b[^.\n]{0,40}\b(?:to be confirmed|unknown|unconfirmed|tbc|tba)\b|\bname to be confirmed\b/i;

/** Words that look like proper nouns and are not people. */
const STOPWORDS = new Set([
  'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'please', 'regards', 'sincerely',
  'best', 'cheers', 'warmly', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'the', 'this', 'that',
  'there', 'here', 'yes', 'okay', 'subject', 'from', 'cc', 'bcc', 're', 'fwd',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'gala', 'conference', 'summit', 'forum', 'webinar',
  'workshop', 'registration', 'rsvp', 'morning', 'afternoon', 'evening',
  // "Will attend" / "would like" are not people. Without these, the cue
  // "attend" flags the sentence opener.
  'will', 'would', 'like', 'wants', 'want',
  'he', 'she', 'we', 'they', 'him', 'her', 'his', 'our', 'who', 'you', 'your', 'it', 'its',
]);

/**
 * A multi-word span containing any of these is an organisation, place, or
 * event — not a person we should force through contact resolution.
 */
const NON_PERSON = new Set([
  'york', 'london', 'paris', 'toronto', 'vancouver', 'ottawa', 'calgary', 'montreal',
  'boston', 'chicago', 'seattle', 'francisco', 'angeles', 'washington', 'berlin',
  'tokyo', 'sydney', 'melbourne', 'dublin', 'houston', 'dallas', 'austin', 'denver',
  'atlanta', 'miami', 'portland', 'beijing', 'shanghai', 'singapore', 'dubai',
  'munich', 'zurich', 'geneva', 'rome', 'madrid', 'barcelona', 'amsterdam',
  'brussels', 'vienna', 'prague', 'lisbon', 'oslo', 'stockholm', 'helsinki',
  'copenhagen', 'auckland', 'wellington', 'canberra', 'quebec', 'ontario', 'alberta',
  'columbia', 'island', 'street', 'avenue', 'road', 'boulevard', 'suite', 'floor',
  'building', 'centre', 'center', 'inc', 'ltd', 'llc', 'university', 'foundation',
  'fund', 'committee', 'association', 'group', 'team', 'office', 'department',
  'corp', 'corporation', 'company', 'institute', 'school', 'club', 'society',
  'council', 'board', 'hotel', 'cafe', 'restaurant', 'park', 'hall', 'room',
  'plaza', 'square', 'market', 'capital', 'partners', 'ventures', 'holdings',
  'labs', 'studio', 'studios', 'media', 'news', 'times', 'post', 'journal',
  'review', 'weekly', 'daily',
]);

/** Single words that often open a sentence and are not names. */
const SENTENCE_OPENERS = new Set([
  'see', 'let', 'looking', 'following', 'attached', 'forwarding', 'hope', 'just',
  'quick', 'wanted', 'can', 'could', 'would', 'should', 'here', 'there', 'this',
  'that', 'yes', 'good', 'great', 'happy', 'glad', 'sorry', 'unfortunately',
  'confirming', 'confirmed', 'updating', 'update', 'note', 'fyi', 'also',
]);

const EMAIL_LOCAL_STOP = new Set([
  'info', 'hello', 'team', 'support', 'noreply', 'admin', 'office', 'contact',
  'mail', 'news', 'events', 'reply', 'notifications', 'notify',
]);

export interface ResolvedEntityCard {
  contactId: string;
  displayName: string;
  preferredName: string | null;
  role: string | null;
  organization: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
}

/** Contact UUIDs inside `<resolved_entities>` blocks. Other text is ignored. */
export function parseResolvedContactIds(text: string): string[] {
  BLOCK_RE.lastIndex = 0;
  CONTACT_RE.lastIndex = 0;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of text.matchAll(BLOCK_RE)) {
    const body = block[1] ?? '';
    for (const contact of body.matchAll(CONTACT_RE)) {
      const id = attrs(contact[1] ?? '')['id'];
      if (!id || !UUID_RE.test(id)) continue;
      const normalized = id.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return ids;
}

/**
 * Walk a tool result for contact IDs. Honours the structured
 * `resolvedContactIds` field (which survives output sanitization) and any
 * `<resolved_entities>` markup that is still intact.
 */
export function collectResolvedContactIds(value: unknown): string[] {
  const ids: string[] = [];
  const seenObjects = new Set<unknown>();
  walk(value);
  const unique: string[] = [];
  const seenIds = new Set<string>();
  for (const id of ids) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    unique.push(id);
  }
  return unique;

  function walk(node: unknown): void {
    if (typeof node === 'string') {
      ids.push(...parseResolvedContactIds(node));
      return;
    }
    if (Array.isArray(node)) {
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
      for (const [key, child] of Object.entries(node)) {
        if ((key === 'resolvedContactIds' || key === 'resolved_contact_ids') && Array.isArray(child)) {
          for (const item of child) {
            if (typeof item === 'string' && UUID_RE.test(item)) ids.push(item.toLowerCase());
          }
          continue;
        }
        walk(child);
      }
    }
  }
}

/**
 * Render the re-injected block from current contact rows.
 * Returns null when there is nothing to say.
 *
 * `cards` must be newest-first — `ConversationEntityState.load` and `record`
 * both return that order. When the character cap is exceeded the tail
 * (oldest) is dropped. This function does not reorder.
 */
export function formatResolvedEntitiesBlock(
  cards: readonly ResolvedEntityCard[],
  maxChars: number = RESOLVED_ENTITIES_MAX_CHARS,
): string | null {
  if (cards.length === 0) return null;
  const header =
    '[Resolved entities — refreshed this turn from the contact record, not from an earlier message. ' +
    'A <resolved_entities> block is not kept in conversation history. Use these IDs directly. ' +
    'Before sending to anyone but the principal, do not send an unconfirmed name. ' +
    'The platform blocks that, and an unresolved name next to an invitation or attendance cue. ' +
    'Other names are not blocked automatically.]';

  const lines: string[] = [];
  for (const card of cards) {
    lines.push(formatContactLine(card));
    const candidate = assemble(header, lines);
    if (candidate.length > maxChars) {
      lines.pop();
      break;
    }
  }
  if (lines.length === 0) return null;
  return assemble(header, lines);
}

export interface IdentityScan {
  /** Message body. Person-shaped mentions are taken from here only. */
  body: string;
  /**
   * Email subject. Scanned for unconfirmed-name hedges, not for capitalized
   * words — a Title Case subject must not block a clean body.
   */
  subject?: string;
}

/** Why an external send must not go out, or null when nothing person-shaped is unresolved. */
export function describeUnresolvedIdentity(
  text: string | IdentityScan,
  coveredNames: readonly string[],
): string | null {
  const body = typeof text === 'string' ? text : text.body;
  const subject = typeof text === 'string' ? '' : (text.subject ?? '');
  const hedgeText = subject === '' ? body : `${subject}\n${body}`;
  const hedges = HEDGE_RE.test(hedgeText);
  const uncovered = uncoveredMentions(body, coveredNames);
  if (!hedges && uncovered.length === 0) return null;

  const parts: string[] = [];
  if (uncovered.length > 0) {
    const listed = uncovered.slice(0, 5).map(name => `"${name}"`).join(', ');
    const verb = uncovered.length === 1 ? 'is' : 'are';
    parts.push(
      `${listed} ${verb} not resolved to a contact ID in this turn. ` +
      'Resolve them with the contacts specialist only if they are a person. ' +
      'If the word is a product, place, or title, rephrase the sentence.',
    );
  }
  if (hedges) {
    parts.push(
      'This message tells an external recipient that a name is unconfirmed. ' +
      'Use the full name from this turn\'s <resolved_entities> block, or resolve the person first.',
    );
  }
  return `Unresolved identity: ${parts.join(' ')} Do not send a partial identity to an external recipient.`;
}

/**
 * Given-name tokens from an email local part (`dani@…` → `dani`), so addressing
 * the recipient by the name in their address is not treated as an unresolved person.
 */
export function emailLocalNameTokens(identifier: string): string[] {
  const at = identifier.lastIndexOf('@');
  if (at <= 0 || /\s/.test(identifier)) return [];
  const local = identifier.slice(0, at);
  const tokens: string[] = [];
  for (const part of local.split(/[._+-]+/)) {
    const lower = part.toLowerCase();
    if (!/^[a-z]{3,}$/.test(lower)) continue;
    if (EMAIL_LOCAL_STOP.has(lower)) continue;
    tokens.push(lower);
  }
  return tokens;
}

function uncoveredMentions(text: string, coveredNames: readonly string[]): string[] {
  const sets = coveredNames
    .map(nameTokens)
    .filter(tokens => tokens.length > 0);
  const stripped = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of collectNameSpans(stripped)) {
    const raw = match.raw;
    const index = match.index;
    // A name span counts only with a nearby person cue. Title Case on its
    // own ("Google Drive", a subject line) is not a person.
    if (!hasPersonCue(stripped, index, raw.length)) continue;
    // Drop greeting words glued to a name ("Hello Dani" → "Dani") so the
    // coverage check sees the person, not the salutation.
    const tokens = trimStopwords(nameTokens(raw));
    if (tokens.length === 0) continue;
    if (tokens.length > 1 && tokens.some(token => NON_PERSON.has(token))) continue;
    // A single ordinary opener at the start of a sentence ("See you Monday")
    // is not a name. An uncommon word there ("Xiaopu would like"), a list
    // item ("- Xiaopu"), and a mid-sentence mention ("and Xiaopu") still are.
    if (
      tokens.length === 1 &&
      isSentenceInitial(stripped, index) &&
      !isListItem(stripped, index) &&
      SENTENCE_OPENERS.has(tokens[0]!)
    ) continue;
    if (isCovered(tokens, sets)) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(raw);
  }
  return found;
}

function collectNameSpans(text: string): Array<{ raw: string; index: number }> {
  const spans: Array<{ raw: string; index: number }> = [];
  NAME_RE.lastIndex = 0;
  for (const match of text.matchAll(NAME_RE)) {
    spans.push({ raw: match[0], index: match.index ?? 0 });
  }
  CJK_NAME_RE.lastIndex = 0;
  for (const match of text.matchAll(CJK_NAME_RE)) {
    spans.push({ raw: match[0], index: match.index ?? 0 });
  }
  return spans;
}

/**
 * Cue window stays inside the paragraph so a signature is not tainted by
 * "attend" above it. A cue that overlaps the mention itself does not count:
 * "Attendees:" matches both the name pattern and the cue list, and must not
 * vouch for itself.
 */
function hasPersonCue(text: string, index: number, length: number): boolean {
  let start = Math.max(0, index - 60);
  let end = Math.min(text.length, index + length + 60);
  const before = text.slice(start, index);
  const blankBefore = before.lastIndexOf('\n\n');
  if (blankBefore >= 0) start += blankBefore + 2;
  const after = text.slice(index + length, end);
  const blankAfter = /\n[ \t]*\n/.exec(after);
  if (blankAfter && blankAfter.index >= 0) end = index + length + blankAfter.index;
  const windowText = text.slice(start, end);
  const mentionStart = index - start;
  const mentionEnd = mentionStart + length;
  const cues = new RegExp(PERSON_CUE_RE.source, 'giu');
  for (const match of windowText.matchAll(cues)) {
    const cueStart = match.index ?? 0;
    const cueEnd = cueStart + match[0].length;
    if (cueEnd <= mentionStart || cueStart >= mentionEnd) return true;
  }
  return false;
}

function isSentenceInitial(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0) return true;
  const last = text[i];
  return last === '.' || last === '!' || last === '?' || last === '\n' || last === '\r';
}

function isListItem(text: string, index: number): boolean {
  return /(?:^|\n)\s*[-*•]\s*$/.test(text.slice(0, index));
}

function isCovered(mention: string[], sets: string[][]): boolean {
  return sets.some(set => mention.every(token => set.includes(token)));
}

function nameTokens(name: string): string[] {
  const tokens: string[] = [];
  for (const match of name.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
    const token = match[0].toLowerCase();
    // Two letters so "Al Li" and "李伟" count. One letter ("A") does not.
    if ([...token].length < 2) continue;
    tokens.push(token);
  }
  return tokens;
}

function trimStopwords(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && STOPWORDS.has(tokens[start]!)) start++;
  while (end > start && STOPWORDS.has(tokens[end - 1]!)) end--;
  return tokens.slice(start, end);
}

function assemble(header: string, lines: string[]): string {
  return `${header}\n\n<resolved_entities>\n${lines.join('\n')}\n</resolved_entities>`;
}

function formatContactLine(card: ResolvedEntityCard): string {
  const attrs: Array<[string, string | null]> = [
    ['id', card.contactId],
    ['name', card.displayName],
    ['preferred', card.preferredName],
    ['role', card.role],
    ['org', card.organization],
    ['email', card.primaryEmail],
    ['phone', card.primaryPhone],
  ];
  const rendered = attrs
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');
  return `  <contact ${rendered}/>`;
}

function escapeAttr(value: string): string {
  // Slice the raw text first. Escaping and then slicing can cut an entity
  // in half (`&amp;` → `&amp`).
  return value
    .slice(0, 120)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ');
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const key = match[1];
    if (!key) continue;
    out[key.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return out;
}
