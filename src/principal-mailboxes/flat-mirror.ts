// flat-mirror.ts — keep the flat principal-mailbox keys equal to the registry's default (#2475).
//
// Until Part 2 retires them, ceo-inbox still reads ceo_nylas_grant_id / ceo_self_email. Once
// the registry has rows they are a copy of the default mailbox (R28): PrincipalMailboxAdmin
// writes them on every change, and this re-derives them at boot and on each health-canary
// tick. So a copy that failed part-way (after a grant replacement, a new default, or the clear
// after removing the default) or a value written from outside the console is repaired without
// the operator. Flat keys for a default the registry cannot serve (no grant) are cleared. While the registry is empty the flat keys are the source, and nothing changes.
//
// Logs name keys and mailbox ids only, never a grant id (R20).
import type { Logger } from '../logger.js';
import type { PrincipalMailboxStore } from './store.js';
import { principalMailboxGrantSecretName } from './secrets.js';

export type FlatMirrorOutcome = 'unmanaged' | 'in_sync' | 'mirrored' | 'cleared' | 'no_grant';

export interface FlatMirrorDeps {
  store: Pick<PrincipalMailboxStore, 'hasAnyRow' | 'listLive'>;
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  logger: Logger;
}

const FLAT_GRANT_KEY = 'ceo_nylas_grant_id';
const FLAT_EMAIL_KEY = 'ceo_self_email';

export async function reconcileFlatMailboxKeys(deps: FlatMirrorDeps): Promise<FlatMirrorOutcome> {
  const { store, secrets, logger } = deps;
  if (!(await store.hasAnyRow())) return 'unmanaged';

  const flatGrant = await secrets.get(FLAT_GRANT_KEY);
  const flatEmail = await secrets.get(FLAT_EMAIL_KEY);
  const def = (await store.listLive()).find((m) => m.isDefault);

  if (!def) {
    // Every mailbox was removed: nothing may keep acting on the last one's grant.
    if (flatGrant === null && flatEmail === null) return 'in_sync';
    if (flatGrant !== null) await secrets.delete(FLAT_GRANT_KEY);
    if (flatEmail !== null) await secrets.delete(FLAT_EMAIL_KEY);
    logger.warn('Cleared the flat principal-mailbox keys: no live default mailbox');
    return 'cleared';
  }

  const grant = await secrets.get(principalMailboxGrantSecretName(def.id));
  if (!grant) {
    // The registry refuses a mailbox without a grant (credentials() throws), so ceo-inbox must
    // not keep acting through a flat copy of it either.
    if (flatGrant !== null) await secrets.delete(FLAT_GRANT_KEY);
    if (flatEmail !== null) await secrets.delete(FLAT_EMAIL_KEY);
    logger.error({ mailboxId: def.id }, 'The default principal mailbox has no grant in the vault; cleared the flat principal-mailbox keys');
    return 'no_grant';
  }
  const address = def.address.trim().toLowerCase();
  if (flatGrant === grant && flatEmail === address) return 'in_sync';
  await secrets.set(FLAT_GRANT_KEY, grant);
  await secrets.set(FLAT_EMAIL_KEY, address);
  logger.warn({ mailboxId: def.id }, 'The flat principal-mailbox keys differed from the default mailbox; copied it into them');
  return 'mirrored';
}
