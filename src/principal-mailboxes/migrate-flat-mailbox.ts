// migrate-flat-mailbox.ts — move the single flat principal mailbox (ceo_nylas_grant_id) into
// the principal_mailboxes registry at boot (#2475, D1).
//
// Runs only while the registry has no live mailbox and the flat grant is set. It copies the
// grant to principal.mailbox.<id>.nylas_grant_id and inserts the default row. It never
// touches identities and never deletes the flat keys (Part 2 retires them).
//
// Deliberately does not import channels/calendar/resolve-calendar-grant.ts (R9): it reads the
// flat keys directly.
import type { Logger } from '../logger.js';
import type { PrincipalMailboxStore } from './store.js';
import { principalMailboxGrantSecretName } from './secrets.js';
import { RESERVED_MAILBOX_IDS } from './types.js';
import { grantSafeErrorFields } from './error-fields.js';

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
  logger: Logger;
}

const FLAT_GRANT_KEY = 'ceo_nylas_grant_id';
const FLAT_EMAIL_KEY = 'ceo_self_email';

/** `gmail` for gmail.com / googlemail.com, else the domain's first label ([a-z0-9-], `m-` before a digit). */
export function mailboxIdFromAddress(address: string): string {
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  const label = (domain.split('.')[0] ?? '').replace(/[^a-z0-9-]/g, '');
  let id = label === '' ? 'mailbox' : label;
  if (/^[0-9-]/.test(id)) id = `m-${id}`;
  id = id.slice(0, 32);
  // The registry refuses reserved ids (CHECK constraint); prefix rather than fail every boot.
  if (RESERVED_MAILBOX_IDS.has(id)) id = `m-${id}`;
  return id;
}

function labelFromId(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export async function migrateFlatPrincipalMailbox(
  deps: FlatMailboxMigrationDeps,
): Promise<FlatMailboxMigrationOutcome> {
  const { store, secrets, lookupGrant, logger } = deps;

  // Any row, removed ones included: a principal who removed their only mailbox must not have
  // it revived from the still-present flat keys on the next boot.
  if (await store.hasAnyRow()) return 'already';

  const grantId = (await secrets.get(FLAT_GRANT_KEY))?.trim();
  if (!grantId) return 'nothing';

  let address: string | undefined;
  try {
    const grant = await lookupGrant(grantId);
    address = grant.email.trim().toLowerCase() || undefined;
  } catch (err) {
    // Class and status only: a Nylas error can carry the grant id (R20).
    logger.warn(grantSafeErrorFields(err), 'Mailbox migration: Nylas grant lookup failed; trying ceo_self_email');
  }
  if (!address) {
    address = (await secrets.get(FLAT_EMAIL_KEY))?.trim().toLowerCase() || undefined;
  }
  if (!address) {
    logger.warn('Mailbox migration deferred: no address from the grant or ceo_self_email');
    return 'deferred';
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
  return 'migrated';
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
