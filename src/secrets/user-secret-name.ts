// user-secret-name.ts — deterministic `user.*` vault-key policy (#1497).
//
// Capture used to slugify the agent's free-text `secret_name` verbatim, so the same
// real-world secret minted in two sessions landed under two keys (`user.x_com_password`
// vs `user.my_twitter_x_password`). This module is the naming standard:
//
//   1. Exact reuse — if the caller passes an existing `user.<slug>` key, keep it.
//   2. Canonicalize — strip filler/TLDs, fold known synonyms (x → twitter), append a
//      type suffix (`password`, `login`, …), sort identity tokens.
//   3. Fingerprint match — if an existing `user.*` key canonicalizes to the same
//      fingerprint, reuse that key (oldest first) so pre-standard slugs update in place
//      instead of forking. Prod cleanup of already-forked duplicates is follow-up C.
//
// The `user.` prefix is still a structural sandbox: nothing in this file can emit a
// dot-free system key or a `channel.*` credential key.

/** Trust-boundary prefix for agent-captured personal secrets (#971 / #1497). */
export const USER_SECRET_PREFIX = 'user.';

const MAX_SECRET_NAME_INPUT = 128;

const USER_KEY_RE = /^user\.[a-z0-9_]+$/;

/** Filler tokens dropped from identity. `for` is handled separately (drops itself + next). */
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'me', 'mine', 'our', 'your', 'their', 'his', 'her', 'its',
  'user', 'users', 'account', 'accounts', 'site', 'website', 'web', 'page',
]);

const TLDS = new Set(['com', 'org', 'net', 'io', 'www', 'http', 'https', 'html']);

/** Identity synonyms. Token `x` is the Twitter/X rebrand — the incident that prompted #1497. */
const SYNONYMS: Readonly<Record<string, string>> = {
  x: 'twitter',
  xcom: 'twitter',
};

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

/**
 * Slugify free text (or a `user.*` key) into lowercase underscore tokens.
 * Shared by canonicalize and fingerprint so existing slugs and new descriptions
 * go through the same tokenizer.
 */
function slugifySecretName(input: string): string {
  const stripped = input.trim().toLowerCase().startsWith(USER_SECRET_PREFIX)
    ? input.trim().slice(USER_SECRET_PREFIX.length)
    : input.trim();
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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

/** Fingerprint a free-text description or an existing `user.*` key. */
export function fingerprintUserSecret(input: string): UserSecretFingerprint {
  const tokens = tokenize(slugifySecretName(input));
  const identity: string[] = [];
  let type: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!;
    // "password for josephfung" — drop `for` and the following possessive/name token.
    if (raw === 'for' && i + 1 < tokens.length) {
      i += 1;
      continue;
    }
    if (FILLER.has(raw) || TLDS.has(raw)) continue;

    const mapped = SYNONYMS[raw] ?? raw;
    const typeCanon = TYPE_CANONICAL[mapped] ?? TYPE_CANONICAL[raw];
    if (typeCanon !== undefined) {
      type = pickType(type, typeCanon);
      continue;
    }
    identity.push(mapped);
  }

  const unique: string[] = [];
  for (const token of identity) {
    if (!unique.includes(token)) unique.push(token);
  }
  return { identity: unique, type };
}

/**
 * Canonical `user.<identity>_<type>` key for a description. Does not consult
 * existing keys — call `resolveUserSecretName` for reuse/dedup.
 */
export function canonicalizeUserSecretName(input: string): string {
  const fp = fingerprintUserSecret(input);
  const parts = fp.type ? [...fp.identity, fp.type] : fp.identity;
  if (parts.length === 0) {
    throw new Error(`secret_name '${input}' has no usable alphanumeric characters`);
  }
  return `${USER_SECRET_PREFIX}${parts.join('_')}`;
}

/**
 * Resolve a user-secret vault key from free text (or an existing `user.*` name).
 *
 * `existingUserKeys` MUST be `user.*` names only, oldest-first (created_at ASC).
 * The first fingerprint match wins so a recapture updates the original key
 * rather than a later duplicate.
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
  const proposedFp = fingerprintKey(fingerprintUserSecret(trimmed));

  for (const existing of existingUserKeys) {
    if (!existing.startsWith(USER_SECRET_PREFIX)) continue;
    if (fingerprintKey(fingerprintUserSecret(existing)) === proposedFp) {
      return existing;
    }
  }

  return proposed;
}
