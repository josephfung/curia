// migrate-flat-mailbox.ts — move the single flat principal mailbox (ceo_nylas_grant_id) into
// the principal_mailboxes registry at boot (#2475, D1).
//
// Migrates only while the registry has no row and the flat grant is set. It copies the
// grant to principal.mailbox.<id>.nylas_grant_id and inserts the default row. It never
// touches identities.
//
// Then, on every boot, it retires the flat keys (ceo_nylas_grant_id, ceo_self_email): copy, then
// delete. They are deleted only once the registry serves them, i.e. a live default row exists
// and its grant secret is stored. While the migration is deferred there is no row, so the
// deferred fallback (service.ts) keeps reading ceo_nylas_grant_id.
import type { Logger } from '../logger.js';
import type { PrincipalMailboxStore } from './store.js';
import { FLAT_EMAIL_KEY, FLAT_GRANT_KEY, principalMailboxGrantSecretName } from './secrets.js';
import { RESERVED_MAILBOX_IDS } from './types.js';
import { FALLBACK_MAILBOX_ID } from './state-keys.js';
import { grantSafeErrorFields, mayCarryGrantId } from './error-fields.js';

export type FlatMailboxMigrationOutcome = 'migrated' | 'already' | 'nothing' | 'deferred';

export interface FlatMailboxMigrationDeps {
  store: PrincipalMailboxStore;
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  lookupGrant: (grantId: string) => Promise<{ email: string; provider: string }>;
  /** D1: whether the address is a verified principal email identity. Read only, to warn;
   *  the migration never writes identities. Absent (no principal contact yet) → no check. */
  isVerifiedPrincipalEmail?: (address: string) => Promise<boolean>;
  /** F5: Curia's own account addresses and grants; a flat mailbox that is one of them is never
   *  registered (the same refusal as adding one in the console). */
  curiaAccountAddresses?: () => Promise<string[]>;
  curiaAccountGrantIds?: () => Promise<string[]>;
  /** Told why a 'deferred' outcome was deferred (operator-facing, no address or grant id). */
  onDeferred?: (reason: string) => void;
  logger: Logger;
}


/** `gmail` for gmail.com / googlemail.com, else the domain's first label ([a-z0-9-], `m-` before a digit). */
export function mailboxIdFromAddress(address: string): string {
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  const label = (domain.split('.')[0] ?? '').replace(/[^a-z0-9-]/g, '');
  // An empty label falls back to a fixed id that is not the reserved fallback sentinel (R63).
  let id = label === '' ? `m-${FALLBACK_MAILBOX_ID}` : label;
  if (/^[0-9-]/.test(id)) id = `m-${id}`;
  id = id.slice(0, 32);
  // The registry refuses reserved ids (CHECK constraint); prefix rather than fail every boot.
  if (RESERVED_MAILBOX_IDS.has(id)) id = `m-${id}`;
  return id;
}

/**
 * R63: the deferred-fallback id is reserved, but a registry row may already use it (PR 1 shipped
 * before the reservation). Such a mailbox would claim fallback-period records. Warn at boot so the
 * operator can replace it (add a mailbox under another id, then remove this one). True if it warned.
 */
export function warnIfFallbackIdIsLive(liveIds: readonly string[], logger: Pick<Logger, 'warn'>): boolean {
  if (!liveIds.includes(FALLBACK_MAILBOX_ID)) return false;
  logger.warn(
    { mailboxId: FALLBACK_MAILBOX_ID },
    `A live principal mailbox uses the reserved id "${FALLBACK_MAILBOX_ID}": records from before the registry migration will be read as its own. Add the account under another id and remove this one.`,
  );
  return true;
}

function labelFromId(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export async function migrateFlatPrincipalMailbox(
  deps: FlatMailboxMigrationDeps,
): Promise<FlatMailboxMigrationOutcome> {
  const { store, secrets, lookupGrant, logger } = deps;

  // Any row, removed ones included: a principal who removed their only mailbox must not have
  // it revived from flat keys that are still present on the next boot.
  if (await store.hasAnyRow()) {
    await retireFlatMailboxKeys(deps);
    return 'already';
  }

  const grantId = (await secrets.get(FLAT_GRANT_KEY))?.trim();
  if (!grantId) return 'nothing';

  const defer = (reason: string): 'deferred' => {
    logger.warn({ reason }, 'Mailbox migration deferred');
    deps.onDeferred?.(reason);
    return 'deferred';
  };

  let address: string | undefined;
  try {
    const grant = await lookupGrant(grantId);
    // F5: the registry holds Google mailboxes only, as the console's add refuses any other.
    if (grant.provider !== 'google') {
      return defer(`The flat grant is not a Google account (provider ${grant.provider}); only Google mailboxes are supported`);
    }
    address = grant.email.trim().toLowerCase() || undefined;
  } catch (err) {
    // Class and status only: a Nylas error can carry the grant id (R20).
    logger.warn(grantSafeErrorFields(err), 'Mailbox migration: Nylas grant lookup failed; trying ceo_self_email');
  }
  if (!address) {
    address = (await secrets.get(FLAT_EMAIL_KEY))?.trim().toLowerCase() || undefined;
  }
  if (!address) {
    return defer("Curia could not read the grant's address from Nylas, and ceo_self_email is not set");
  }
  // F5: never register one of Curia's own accounts as the principal's mailbox.
  if (deps.curiaAccountAddresses && (await deps.curiaAccountAddresses()).some((a) => a.trim().toLowerCase() === address)) {
    return defer("The flat mailbox is one of Curia's own email accounts, not the principal's");
  }
  if (deps.curiaAccountGrantIds && (await deps.curiaAccountGrantIds()).includes(grantId)) {
    return defer("The flat grant is one of Curia's own email accounts, not the principal's");
  }

  const id = mailboxIdFromAddress(address);
  // Vault first: a failure between the two writes leaves an unused secret, never a row
  // that points at a missing grant. A retry overwrites it with the same value.
  const secretName = principalMailboxGrantSecretName(id);
  await secrets.set(secretName, grantId);
  try {
    await store.insert({
      id,
      label: labelFromId(id),
      address,
      provider: 'google', // the only provider that exists
      isDefault: true,
      triageStartAt: null,
      addedIdentityId: null,
    });
  } catch (err) {
    // A concurrent boot inserted the same mailbox first: its row needs the secret we both
    // wrote (same id, same grant), so it stays.
    if ((err as { code?: unknown } | null)?.code === '23505') {
      logger.info({ mailboxId: id }, 'Mailbox migration: another process registered the mailbox first');
      return 'already';
    }
    try {
      await secrets.delete(secretName);
    } catch (delErr) {
      logger.warn({ err: delErr, mailboxId: id }, 'Mailbox migration: could not remove the grant secret after a failed insert');
    }
    throw err;
  }
  logger.info({ mailboxId: id }, 'Migrated the principal mailbox into the registry');
  await warnIfUnverified(deps, id, address);
  await retireFlatMailboxKeys(deps);
  return 'migrated';
}

export type FlatKeyRetirement = 'none' | 'deleted' | 'kept';

/**
 * Deletes the retired flat keys once the registry serves the mailbox they held: a live default
 * row exists and its grant secret is stored (#2475). Idempotent, and run on every boot, so an
 * install migrated before the keys were retired loses them on its first boot after the upgrade.
 * Kept (with a warning) when the default row or its grant is missing: the flat grant may then be
 * the only copy. Never throws: a failed read or delete is logged, and the next boot retries.
 * Logs name keys and mailbox ids only, never a value (R20).
 */
export async function retireFlatMailboxKeys(
  deps: Pick<FlatMailboxMigrationDeps, 'store' | 'secrets' | 'logger'>,
): Promise<FlatKeyRetirement> {
  const { store, secrets, logger } = deps;
  try {
    const present: string[] = [];
    for (const key of [FLAT_GRANT_KEY, FLAT_EMAIL_KEY]) {
      if ((await secrets.get(key)) !== null) present.push(key);
    }
    if (present.length === 0) return 'none';

    const def = (await store.listLive()).find((m) => m.isDefault);
    const grant = def ? (await secrets.get(principalMailboxGrantSecretName(def.id)))?.trim() : undefined;
    if (!def || !grant) {
      logger.warn(
        { keys: present, ...(def ? { mailboxId: def.id } : {}) },
        def
          ? 'Kept the flat mailbox keys: the default mailbox has no grant in the vault yet (use Replace grant on it in the console)'
          : 'Kept the flat mailbox keys: the registry has no live default mailbox',
      );
      return 'kept';
    }
    // The grant is copied already (the migration stored it under the mailbox), so delete.
    for (const key of present) await secrets.delete(key);
    logger.info({ keys: present, mailboxId: def.id }, 'Deleted the retired flat mailbox keys; the registry serves the mailbox');
    return 'deleted';
  } catch (err) {
    // A vault or database error names no grant, so its message is kept; a Nylas-shaped one is not (R20).
    logger.warn(
      err instanceof Error && !mayCarryGrantId(err) ? { ...grantSafeErrorFields(err), errMessage: err.message } : grantSafeErrorFields(err),
      'Could not retire the flat mailbox keys; retrying at the next boot',
    );
    return 'kept';
  }
}

// D1: the migration leaves identities alone, so an address that is not a verified principal
// email is only reported. No address in the log (public logs).
async function warnIfUnverified(deps: FlatMailboxMigrationDeps, id: string, address: string): Promise<void> {
  if (!deps.isVerifiedPrincipalEmail) return;
  try {
    if (!(await deps.isVerifiedPrincipalEmail(address))) {
      deps.logger.warn({ mailboxId: id }, "Mailbox migration: the migrated mailbox's address is not a verified principal email");
    }
  } catch (err) {
    deps.logger.warn({ mailboxId: id, ...grantSafeErrorFields(err) }, 'Mailbox migration: could not check the principal identity for the migrated address');
  }
}

/** Operator-facing reason after a migration attempt threw: class and status only (R20). */
export function migrationFailureReason(err: unknown): string {
  const { errName, statusCode } = grantSafeErrorFields(err);
  const what = `${errName}${statusCode !== undefined ? `, HTTP ${statusCode}` : ''}`;
  // Only a Nylas failure points at the Nylas settings; a database or vault failure does not.
  return mayCarryGrantId(err)
    ? `The last attempt failed (${what}); check the Nylas API key and the grant`
    : `The last attempt failed (${what}); see the server log for the cause`;
}
