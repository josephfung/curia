// PrincipalMailboxAdmin — add, set default and remove principal mailboxes (#2475).
// Service layer only: routes and bootstrap wire it later. Adding never changes the
// principal's primary email; removal can require a new one so notices never keep going
// to an address the principal no longer reads.
import type { Logger } from '../logger.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { PrincipalMailboxStore } from './store.js';
import type { PrincipalMailboxView } from './service.js';
import { principalMailboxGrantSecretName } from './secrets.js';
import {
  MAILBOX_ID_RE,
  MAX_LIVE_MAILBOXES,
  RESERVED_MAILBOX_IDS,
  RemovedMailboxError,
  UnknownMailboxError,
  type PrincipalMailboxRecord,
} from './types.js';

export type AddMailboxRefusal =
  | 'bad_id'
  | 'id_taken'
  | 'cap_reached'
  | 'not_google'
  | 'grant_in_use'
  | 'address_in_use'
  | 'curia_account_address'
  | 'grant_unreadable'
  | 'address_is_another_contact';

export interface RemovalPreview {
  mailbox: PrincipalMailboxView;
  isDefault: boolean;
  isPrimaryEmail: boolean;
  /** True only for consumer domains, where the address plausibly stays the principal's. */
  stillOwnedDefault: boolean;
  otherLive: PrincipalMailboxView[];
  /** Filled by the rules task via onRemoved hooks / later deps; [] in this part. */
  scopedRules: Array<{ title: string; onlyThisMailbox: boolean }>;
  /** Filled by the calendar task; [] in this part. */
  calendars: Array<{ calendarId: string; label: string }>;
}

/** A removal request that breaks a precondition; nothing was changed. */
export class MailboxRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxRemovalError';
  }
}

export interface PrincipalMailboxAdminDeps {
  store: Pick<PrincipalMailboxStore, 'listLive' | 'getAny' | 'insert' | 'setDefault' | 'tombstone'>;
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  contacts: Pick<
    ContactService,
    'linkIdentity'
    | 'unlinkIdentity'
    | 'getContactWithIdentities'
    | 'updateContactFields'
    | 'verifyIdentity'
    | 'setIdentityStatus'
    | 'resolveByChannelIdentity'
  >;
  principalContactId: string;
  curiaAccountAddresses: () => Promise<string[]>;
  lookupGrant: (grantId: string) => Promise<{ email: string; provider: string }>;
  onRemoved?: Array<(id: string) => Promise<void>>;
  logger: Logger;
  /** Test seam: the live-mailbox cap. Defaults to MAX_LIVE_MAILBOXES. */
  maxLiveMailboxes?: number;
}

const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

const lower = (s: string): string => s.trim().toLowerCase();

function toView(r: PrincipalMailboxRecord): PrincipalMailboxView {
  return { id: r.id, label: r.label, address: r.address, isDefault: r.isDefault, triageStartAt: r.triageStartAt };
}

export class PrincipalMailboxAdmin {
  private readonly log: Logger;
  private readonly cap: number;

  constructor(private readonly deps: PrincipalMailboxAdminDeps) {
    this.log = deps.logger.child({ component: 'principal-mailbox-admin' });
    this.cap = deps.maxLiveMailboxes ?? MAX_LIVE_MAILBOXES;
  }

  async add(input: {
    id: string;
    label: string;
    grantId: string;
    makeDefault?: boolean;
  }): Promise<
    | { ok: true; mailbox: PrincipalMailboxView }
    | { ok: false; refusal: AddMailboxRefusal; detail: string }
  > {
    const refuse = (refusal: AddMailboxRefusal, detail: string) => ({ ok: false as const, refusal, detail });
    const { id, label, grantId } = input;

    if (!MAILBOX_ID_RE.test(id) || RESERVED_MAILBOX_IDS.has(id)) {
      return refuse('bad_id', `"${id}" is not a valid mailbox id`);
    }
    if (await this.deps.store.getAny(id)) {
      return refuse('id_taken', `The mailbox id "${id}" is taken (ids are never reused)`);
    }
    const live = await this.deps.store.listLive();
    if (live.length >= this.cap) {
      return refuse('cap_reached', `At most ${this.cap} mailbox(es) can be connected`);
    }

    let grant: { email: string; provider: string };
    try {
      grant = await this.deps.lookupGrant(grantId);
    } catch (err) {
      this.log.warn({ err, mailboxId: id }, 'Could not read the Nylas grant for a new mailbox');
      return refuse('grant_unreadable', 'The grant could not be read from Nylas');
    }
    if (grant.provider !== 'google') {
      return refuse('not_google', `Only Google mailboxes are supported (got ${grant.provider})`);
    }

    for (const m of live) {
      const stored = await this.deps.secrets.get(principalMailboxGrantSecretName(m.id));
      if (stored === grantId) {
        return refuse('grant_in_use', `That grant is already connected as "${m.label}"`);
      }
    }

    const address = lower(grant.email);
    if (live.some((m) => lower(m.address) === address)) {
      return refuse('address_in_use', `${address} is already a connected mailbox`);
    }
    if ((await this.deps.curiaAccountAddresses()).some((a) => lower(a) === address)) {
      return refuse('curia_account_address', `${address} is one of Curia's own email accounts`);
    }

    // Identity checks before any write. The address may already be an identity of the
    // principal (reused, never unlinked on removal) or of another contact (refused).
    const principal = await this.deps.contacts.getContactWithIdentities(this.deps.principalContactId);
    if (!principal) throw new Error(`Principal contact not found: ${this.deps.principalContactId}`);
    const existing = principal.identities.find(
      (i) => i.channel === 'email' && lower(i.channelIdentifier) === address,
    );
    if (!existing) {
      const owner = await this.deps.contacts.resolveByChannelIdentity('email', address);
      if (owner && owner.contactId !== this.deps.principalContactId) {
        return refuse('address_is_another_contact', `${address} already belongs to another contact`);
      }
    }

    // Write order: secret, identity, row. A failure unwinds what this call created.
    const secretName = principalMailboxGrantSecretName(id);
    await this.deps.secrets.set(secretName, grantId);
    let addedIdentityId: string | null = null;
    try {
      if (existing) {
        // Pre-existing: make it count as a verified, active principal identity, but it is not ours to unlink.
        if (!existing.verified) await this.deps.contacts.verifyIdentity(existing.id);
        if (existing.status !== 'active') await this.deps.contacts.setIdentityStatus(existing.id, 'active');
      } else {
        const created = await this.deps.contacts.linkIdentity({
          contactId: this.deps.principalContactId,
          channel: 'email',
          channelIdentifier: address,
          source: 'ceo_stated',
          verified: true,
        });
        addedIdentityId = created.id;
      }

      // A default insert clears the old default in the same transaction (store.insert).
      await this.deps.store.insert({
        id,
        label,
        address,
        provider: 'google',
        isDefault: live.length === 0 || input.makeDefault === true,
        triageStartAt: new Date(),
        addedIdentityId,
      });
    } catch (err) {
      this.log.error({ err, mailboxId: id }, 'Adding a principal mailbox failed; undoing partial writes');
      await this.undoAdd(secretName, addedIdentityId);
      throw err;
    }

    const rec = await this.deps.store.getAny(id);
    if (!rec) throw new Error(`Mailbox "${id}" vanished after insert`);
    return { ok: true, mailbox: toView(rec) };
  }

  async setDefault(id: string): Promise<void> {
    await this.deps.store.setDefault(id);
  }

  async removalPreview(id: string): Promise<RemovalPreview> {
    const { rec, others } = await this.liveTarget(id);
    const principal = await this.deps.contacts.getContactWithIdentities(this.deps.principalContactId);
    const primary = principal?.contact.primaryEmail ?? null;
    const domain = lower(rec.address).split('@')[1] ?? '';
    return {
      mailbox: toView(rec),
      isDefault: rec.isDefault,
      isPrimaryEmail: primary !== null && lower(primary) === lower(rec.address),
      stillOwnedDefault: CONSUMER_DOMAINS.has(domain),
      otherLive: others.map(toView),
      scopedRules: [],
      calendars: [],
    };
  }

  async remove(input: {
    id: string;
    stillOwned: boolean;
    newDefaultId?: string;
    newPrimaryEmail?: string;
  }): Promise<void> {
    const { id } = input;
    // 1. Validate.
    const { rec, others } = await this.liveTarget(id);
    let newDefault: string | null = null;
    if (rec.isDefault && others.length > 0) {
      if (!input.newDefaultId || !others.some((m) => m.id === input.newDefaultId)) {
        throw new MailboxRemovalError(
          `"${id}" is the default; name a new default among the other live mailboxes`,
        );
      }
      newDefault = input.newDefaultId;
    }

    const principal = await this.deps.contacts.getContactWithIdentities(this.deps.principalContactId);
    if (!principal) throw new Error(`Principal contact not found: ${this.deps.principalContactId}`);
    const address = lower(rec.address);
    const primary = principal.contact.primaryEmail;
    let newPrimary: string | null = null;
    if (primary !== null && lower(primary) === address) {
      const candidate = input.newPrimaryEmail ? lower(input.newPrimaryEmail) : '';
      const allowed =
        candidate !== '' &&
        candidate !== address &&
        (others.some((m) => lower(m.address) === candidate) ||
          principal.identities.some(
            (i) => i.channel === 'email' && i.verified && i.status === 'active' && lower(i.channelIdentifier) === candidate,
          ));
      if (!allowed) {
        throw new MailboxRemovalError(
          `${rec.address} is the principal's primary email; name a new primary email (another live mailbox or a verified principal email)`,
        );
      }
      newPrimary = candidate;
    }

    // 2. Primary email first, so a failure here leaves the mailbox untouched.
    if (newPrimary !== null) {
      await this.deps.contacts.updateContactFields(this.deps.principalContactId, { primaryEmail: newPrimary });
    }

    // 3. Default / tombstone in one store transaction.
    await this.deps.store.tombstone(id, newDefault);

    // 4-6. Past the tombstone: log and rethrow, never un-tombstone.
    try {
      if (!input.stillOwned && rec.addedIdentityId) {
        await this.deps.contacts.unlinkIdentity(rec.addedIdentityId);
      }
      await this.deps.secrets.delete(principalMailboxGrantSecretName(id));
      for (const hook of this.deps.onRemoved ?? []) await hook(id);
    } catch (err) {
      this.log.error({ err, mailboxId: id }, 'Principal mailbox removed but cleanup failed part-way');
      throw err;
    }
  }

  private async liveTarget(id: string): Promise<{ rec: PrincipalMailboxRecord; others: PrincipalMailboxRecord[] }> {
    const rec = await this.deps.store.getAny(id);
    if (!rec) throw new UnknownMailboxError(id);
    if (rec.removedAt) throw new RemovedMailboxError(id, rec.label);
    const others = (await this.deps.store.listLive()).filter((m) => m.id !== id);
    return { rec, others };
  }

  private async undoAdd(secretName: string, identityId: string | null): Promise<void> {
    try {
      if (identityId) await this.deps.contacts.unlinkIdentity(identityId);
      await this.deps.secrets.delete(secretName);
    } catch (err) {
      this.log.error({ err, secretName }, 'Could not undo a failed mailbox add; remove the leftovers by hand');
    }
  }
}
