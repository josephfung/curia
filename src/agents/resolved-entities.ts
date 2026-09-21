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

const NAME_RE = /\b[A-Z][a-z]+(?:['’-][A-Za-z]+)?(?:\s+[A-Z][a-z]+(?:['’-][A-Za-z]+)?){0,2}\b/g;

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
 * Returns null when there is nothing to say. Drops the oldest cards first
 * when the character cap would be exceeded.
 */
export function formatResolvedEntitiesBlock(
  cards: readonly ResolvedEntityCard[],
  maxChars: number = RESOLVED_ENTITIES_MAX_CHARS,
): string | null {
  if (cards.length === 0) return null;
  const header =
    '[Resolved entities — refreshed this turn from the contact record, not from an earlier message. ' +
    'A <resolved_entities> block is not kept in conversation history. Use these IDs directly. ' +
    'Before sending to anyone but the principal, every person you name must appear here or be resolved by a delegation this turn.]';

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

/** Why an external send must not go out, or null when every named person is resolved. */
export function describeUnresolvedIdentity(text: string, coveredNames: readonly string[]): string | null {
  const hedges = HEDGE_RE.test(text);
  const uncovered = uncoveredMentions(text, coveredNames);
  if (!hedges && uncovered.length === 0) return null;

  const parts: string[] = [];
  if (uncovered.length > 0) {
    const listed = uncovered.slice(0, 5).map(name => `"${name}"`).join(', ');
    const verb = uncovered.length === 1 ? 'is' : 'are';
    parts.push(
      `${listed} ${verb} not resolved to a contact ID in this turn. ` +
      'If this is a person, delegate to the contacts specialist before sending. ' +
      'If it is not a person, rephrase without the capitalized name.',
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
  NAME_RE.lastIndex = 0;
  for (const match of stripped.matchAll(NAME_RE)) {
    const raw = match[0];
    const index = match.index ?? 0;
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
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(token => token.length >= 3);
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
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120);
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
