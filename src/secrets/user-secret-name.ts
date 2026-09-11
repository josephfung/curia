// user-secret-name.ts — deterministic `user.*` vault-key policy (#1497).
//
// Capture used to slugify the agent's free-text `secret_name` verbatim, so the same
// real-world secret minted in two sessions landed under two keys (`user.x_com_password`
// vs `user.my_twitter_x_password`). This module is the naming standard:
//
//   1. Exact reuse — if the caller passes an existing `user.<slug>` key, keep it.
//   2. Canonicalize — strip filler/TLDs, fold the Twitter/X rebrand when unambiguous,
//      append a type suffix (`password`, `login`, …). Identity tokens stay in first-seen
//      order. If no identity token survives, fall back to the raw slug rather than a
//      type-only key (`user.password`) that would collide across sites.
//   3. Fingerprint match — if an existing `user.*` key has the same non-empty identity
//      fingerprint, reuse that key (oldest first) so pre-standard slugs update in place
//      instead of forking. Prod cleanup of already-forked duplicates is follow-up C.
//
// The `user.` prefix is still a structural sandbox: nothing in this file can emit a
// dot-free system key or a `channel.*` credential key.

/** Trust-boundary prefix for agent-captured personal secrets (#971 / #1497). */
export const USER_SECRET_PREFIX = 'user.';

const MAX_SECRET_NAME_INPUT = 128;

const USER_KEY_RE = /^user\.[a-z0-9_]+$/;

/** Filler tokens dropped from identity. `for` is a preposition, not a discriminator —
 *  skipping the *following* token would treat "gmail password for work" as `gmail` and
 *  overwrite `user.gmail_password`. `s` is leftover from English possessives (`'s`). */
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'me', 'mine', 'our', 'your', 'their', 'his', 'her', 'its',
  'user', 'users', 'account', 'accounts', 'site', 'website', 'web', 'page',
  'for', 's',
]);

const TLDS = new Set(['com', 'org', 'net', 'io', 'www', 'http', 'https', 'html']);

/** Tokens that mean Twitter/X. Applied only when unambiguous (see foldTwitterRebrand). */
const TWITTER_REBRAND = new Set(['x', 'xcom']);

const TYPE_CANONICAL: Readonly<Record<string, string>> = {
  password: 'password',
  passwords: 'password',
  passwd: 'password',
  pass: 'password',
  login: 'login',
  logins: 'login',
  credential: 'credential',
  credentials: 'credential',
  secret: 'secret',
  secrets: 'secret',
  pin: 'pin',
  pins: 'pin',
  token: 'token',
  tokens: 'token',
  key: 'key',
  keys: 'key',
};

/** Lower number = stronger type. Used when a name carries more than one type token. */
const TYPE_PRIORITY: Readonly<Record<string, number>> = {
  password: 0,
  login: 1,
  credential: 2,
  token: 3,
  key: 4,
  secret: 5,
  pin: 6,
};

export interface UserSecretFingerprint {
  /** De-duplicated identity tokens in first-seen order (used to build the canonical key). */
  identity: string[];
  /** Canonical type suffix, or null when the name had no type token. */
  type: string | null;
}

/** Stable string form used to compare two fingerprints (sorted, so word order does not matter). */
export function fingerprintKey(fp: UserSecretFingerprint): string {
  return `${[...fp.identity].sort().join('_')}|${fp.type ?? ''}`;
}

function slugifySecretName(input: string): string {
  let stripped = input.trim();
  if (stripped.toLowerCase().startsWith(USER_SECRET_PREFIX)) {
    stripped = stripped.slice(USER_SECRET_PREFIX.length);
  }
  // English possessives (`account's`, `bank's`) must not become a standalone `s` token.
  stripped = stripped.toLowerCase().replace(/['\u2018\u2019]s\b/g, '');
  return stripped.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function tokenize(slug: string): string[] {
  return slug.split('_').filter(t => t.length > 0);
}

function pickType(current: string | null, candidate: string): string {
  if (current === null) return candidate;
  const curRank = TYPE_PRIORITY[current] ?? 99;
  const nextRank = TYPE_PRIORITY[candidate] ?? 99;
  return nextRank < curRank ? candidate : current;
}

function uniquify(tokens: string[]): string[] {
  const unique: string[] = [];
  for (const token of tokens) {
    if (!unique.includes(token)) unique.push(token);
  }
  return unique;
}

/**
 * Map `x` / `xcom` → `twitter` only when that is unambiguous:
 * the sole identity token ("X.com password"), or `twitter` is already present
 * ("my Twitter/X password"). Leaves "Mac OS X password" and "x.example.com" alone.
 */
function foldTwitterRebrand(identity: string[]): string[] {
  if (!identity.some(t => TWITTER_REBRAND.has(t))) return identity;
  const hasTwitter = identity.includes('twitter');
  const onlyRebrand = identity.every(t => TWITTER_REBRAND.has(t));
  if (!onlyRebrand && !hasTwitter) return identity;
  return uniquify(identity.map(t => (TWITTER_REBRAND.has(t) ? 'twitter' : t)));
}

/** Fingerprint a free-text description or an existing `user.*` key. */
export function fingerprintUserSecret(input: string): UserSecretFingerprint {
  const tokens = tokenize(slugifySecretName(input));
  const identity: string[] = [];
  let type: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    if (FILLER.has(raw) || TLDS.has(raw)) continue;

    const typeCanon = TYPE_CANONICAL[raw];
    if (typeCanon !== undefined) {
      type = pickType(type, typeCanon);
      continue;
    }
    // One-character leftovers (`s` from a missed possessive) are not service names.
    // `x` is the Twitter rebrand token and is handled in foldTwitterRebrand.
    if (raw.length === 1 && !TWITTER_REBRAND.has(raw)) continue;
    identity.push(raw);
  }

  return { identity: foldTwitterRebrand(uniquify(identity)), type };
}

/**
 * Canonical `user.<identity>_<type>` key for a description. Does not consult
 * existing keys — call `resolveUserSecretName` for reuse/dedup.
 *
 * When no identity token survives (filler-only / TLD-only), falls back to the raw
 * slug so we never emit a type-only key like `user.password` that collides across sites.
 */
export function canonicalizeUserSecretName(input: string): string {
  const slug = slugifySecretName(input);
  if (slug.length === 0) {
    throw new Error(`secret_name '${input}' has no usable alphanumeric characters`);
  }
  const fp = fingerprintUserSecret(input);
  if (fp.identity.length === 0) {
    return `${USER_SECRET_PREFIX}${slug}`;
  }
  const parts = fp.type ? [...fp.identity, fp.type] : fp.identity;
  return `${USER_SECRET_PREFIX}${parts.join('_')}`;
}

/**
 * Resolve a user-secret vault key from free text (or an existing `user.*` name).
 *
 * `existingUserKeys` MUST be `user.*` names only, oldest-first (created_at ASC).
 * The first fingerprint match wins so a recapture updates the original key
 * rather than a later duplicate. Fingerprint reuse requires a non-empty identity
 * on both sides — type-only fingerprints (`|password`) are never matched.
 */
export function resolveUserSecretName(input: string, existingUserKeys: readonly string[] = []): string {
  if (typeof input !== 'string') throw new Error('secret_name must be a string');
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error('secret_name must not be empty');
  if (trimmed.length > MAX_SECRET_NAME_INPUT) {
    throw new Error(`secret_name exceeds ${MAX_SECRET_NAME_INPUT} characters`);
  }

  // Exact reuse: the agent listed a key and passed it back. Don't rewrite it.
  if (USER_KEY_RE.test(trimmed) && existingUserKeys.includes(trimmed)) {
    return trimmed;
  }

  const slug = slugifySecretName(trimmed);
  if (slug.length === 0) {
    throw new Error(`secret_name '${input}' has no usable alphanumeric characters`);
  }

  const proposed = canonicalizeUserSecretName(trimmed);
  const proposedFp = fingerprintUserSecret(trimmed);
  // Empty identity is not a match key — `|password` would collide across sites.
  if (proposedFp.identity.length > 0) {
    const proposedKey = fingerprintKey(proposedFp);
    for (const existing of existingUserKeys) {
      if (!existing.startsWith(USER_SECRET_PREFIX)) continue;
      const existingFp = fingerprintUserSecret(existing);
      if (existingFp.identity.length === 0) continue;
      if (fingerprintKey(existingFp) === proposedKey) {
        return existing;
      }
    }
  }

  return proposed;
}
