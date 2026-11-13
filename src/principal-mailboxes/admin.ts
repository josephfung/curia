// PrincipalMailboxAdmin — add, set default and remove principal mailboxes (#2475).
// Service layer only: routes and bootstrap wire it later. Adding never changes the
// principal's primary email; removal can require a new one so notices never keep going
// to an address the principal no longer reads.
import type { Logger } from '../logger.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { PrincipalMailboxStore } from './store.js';
import type { PrincipalMailboxView } from './service.js';
import { principalMailboxGrantSecretName } from './secrets.js';
import { applyRemoval, parseRuleScopes, type RuleRemovalAction } from './rules-scope.js';
import { grantLookupFailureDetail, grantSafeErrorFields, mayCarryGrantId } from './error-fields.js';
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

export type ReplaceGrantRefusal = 'grant_unreadable' | 'not_google' | 'address_mismatch' | 'grant_in_use';

export interface RemovalPreview {
  mailbox: PrincipalMailboxView;
  isDefault: boolean;
  isPrimaryEmail: boolean;
  /** True only for consumer domains, where the address plausibly stays the principal's. */
  stillOwnedDefault: boolean;
  otherLive: PrincipalMailboxView[];
  /** Addresses that can become the new primary email: other live mailboxes plus verified
   *  active principal email identities, minus the removed address; lowercased, deduped. */
  primaryEmailCandidates: string[];
  /** Inbox rules that name this mailbox; onlyThisMailbox = they stop applying once it is removed. */
  scopedRules: Array<{ title: string; onlyThisMailbox: boolean }> | null;
  /** True when the rules document could not be read: scopedRules is then null (unknown). */
  rulesUnreadable: boolean;
  /** Filled by the calendar task; [] in this part. */
  calendars: Array<{ calendarId: string; label: string }>;
}

/** Outcome of a removal that went through: the tombstone is committed whatever else failed. */
export interface RemovalOutcome {
  /** Cleanup steps after the tombstone that did not finish (names only). Empty when all did. */
  cleanupIncomplete: string[];
  /** The removed mailbox was the default, so calendar still holds its grant (bound at boot)
   *  until a restart. */
  restartRequired: boolean;
}

/** Shown when the registry change committed but copying the default into the flat keys failed. */
export const MIRROR_PENDING_WARNING =
  'Saved. Copying the default mailbox to the settings the inbox tools read failed; Curia retries at the next restart and health check.';

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
  /** Grant ids of Curia's own email accounts (F6): a mailbox may never reuse one. */
  curiaAccountGrantIds?: () => Promise<string[]>;
  /** Re-derives the flat keys from the registry (flat-mirror.ts). Run when a mirror write
   *  after a committed change fails, and after every removal, so they never keep a stale grant. */
  reconcileFlatKeys?: () => Promise<unknown>;
  lookupGrant: (grantId: string) => Promise<{ email: string; provider: string }>;
  onRemoved?: Array<(id: string) => Promise<void>>;
  /** The standing inbox rules document (/shared/inbox/rules.md), for scoped rules on removal. */
  rulesDoc?: { read(): Promise<string | null>; write(s: string, summary?: string): Promise<void> };
  /** Drops the legacy `default` ceo_inbox/sending key; best-effort after a tombstone (R41). */
  forgetLegacySendLevel?: () => Promise<void>;
  /** True while the deferred-migration fallback is served. An add then would end the
   *  fallback (any row hides it) and drop the flat mailbox from the list, so add refuses. */
  isFallbackActive?: () => Promise<boolean>;
  logger: Logger;
  /** Test seam: the live-mailbox cap. Defaults to MAX_LIVE_MAILBOXES. */
  maxLiveMailboxes?: number;
}

// The flat keys ceo-inbox still reads (#2409).
const FLAT_GRANT_KEY = 'ceo_nylas_grant_id';
const FLAT_EMAIL_KEY = 'ceo_self_email';

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
    | { ok: true; mailbox: PrincipalMailboxView; warning?: string }
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
    if (this.deps.isFallbackActive && (await this.deps.isFallbackActive())) {
      return refuse(
        'cap_reached',
        'The existing mailbox is still being moved into the list; add another once it shows here',
      );
    }
    const live = await this.deps.store.listLive();
    if (live.length >= this.cap) {
      return refuse('cap_reached', `At most ${this.cap} mailbox(es) can be connected`);
    }

    let grant: { email: string; provider: string };
    try {
      grant = await this.deps.lookupGrant(grantId);
    } catch (err) {
      // Class name only: a lookup error's message could carry the grant id.
      this.log.warn({ ...grantSafeErrorFields(err), mailboxId: id }, 'Could not read the Nylas grant for a new mailbox');
      return refuse('grant_unreadable', grantLookupFailureDetail(err));
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
    if (this.deps.curiaAccountGrantIds && (await this.deps.curiaAccountGrantIds()).includes(grantId)) {
      return refuse('curia_account_address', "That grant is one of Curia's own email accounts");
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
    const warning = rec.isDefault
      ? await this.mirrorAfterCommit(id, () => this.mirrorFlatKeys(id, grantId, rec.address))
      : undefined;
    return { ok: true, mailbox: toView(rec), ...(warning ? { warning } : {}) };
  }

  /** The new default is committed first; a failed flat-key copy after it is a warning, not a failure. */
  async setDefault(id: string): Promise<{ warning?: string }> {
    await this.deps.store.setDefault(id);
    const rec = await this.deps.store.getAny(id);
    if (!rec) throw new UnknownMailboxError(id);
    const warning = await this.mirrorAfterCommit(id, () => this.mirrorDefaultFromVault(rec));
    return warning ? { warning } : {};
  }

  /**
   * Point a mailbox at a new Nylas grant for the same account (reconnect after a revoked or
   * expired connection, R29). The grant must be Google's and belong to the mailbox's own
   * address; a grant another live mailbox uses is refused. Unknown or removed ids throw.
   */
  async replaceGrant(
    id: string,
    grantId: string,
  ): Promise<{ ok: true; warning?: string } | { ok: false; refusal: ReplaceGrantRefusal; detail: string }> {
    const refuse = (refusal: ReplaceGrantRefusal, detail: string) => ({ ok: false as const, refusal, detail });
    const { rec, others } = await this.liveTarget(id);

    let grant: { email: string; provider: string };
    try {
      grant = await this.deps.lookupGrant(grantId);
    } catch (err) {
      // Class name only: a lookup error's message could carry the grant id.
      this.log.warn({ ...grantSafeErrorFields(err), mailboxId: id }, 'Could not read the replacement Nylas grant');
      return refuse('grant_unreadable', grantLookupFailureDetail(err));
    }
    if (grant.provider !== 'google') {
      return refuse('not_google', `Only Google mailboxes are supported (got ${grant.provider})`);
    }
    if (lower(grant.email) !== lower(rec.address)) {
      return refuse('address_mismatch', `That grant is for ${lower(grant.email)}, not ${rec.address}`);
    }
    for (const m of others) {
      const stored = await this.deps.secrets.get(principalMailboxGrantSecretName(m.id));
      if (stored === grantId) {
        return refuse('grant_in_use', `That grant is already connected as "${m.label}"`);
      }
    }

    await this.deps.secrets.set(principalMailboxGrantSecretName(id), grantId);
    this.log.info({ mailboxId: id }, 'Principal mailbox grant replaced');
    const warning = rec.isDefault
      ? await this.mirrorAfterCommit(id, () => this.mirrorFlatKeys(id, grantId, rec.address))
      : undefined;
    return warning ? { ok: true, warning } : { ok: true };
  }

  async removalPreview(id: string): Promise<RemovalPreview> {
    const { rec, others } = await this.liveTarget(id);
    const principal = await this.deps.contacts.getContactWithIdentities(this.deps.principalContactId);
    const primary = principal?.contact.primaryEmail ?? null;
    const domain = lower(rec.address).split('@')[1] ?? '';
    const candidates = new Set<string>([
      ...others.map((m) => lower(m.address)),
      ...(principal?.identities ?? [])
        .filter((i) => i.channel === 'email' && i.verified && i.status === 'active')
        .map((i) => lower(i.channelIdentifier)),
    ]);
    candidates.delete(lower(rec.address));
    const scoped = await this.scopedRules(id);
    return {
      mailbox: toView(rec),
      isDefault: rec.isDefault,
      isPrimaryEmail: primary !== null && lower(primary) === lower(rec.address),
      stillOwnedDefault: CONSUMER_DOMAINS.has(domain),
      otherLive: others.map(toView),
      primaryEmailCandidates: [...candidates],
      scopedRules: scoped === null ? null : scoped.map((r) => ({ title: r.title, onlyThisMailbox: r.mailboxes!.length === 1 })),
      rulesUnreadable: scoped === null,
      calendars: [],
    };
  }

  async remove(input: {
    id: string;
    stillOwned: boolean;
    newDefaultId?: string;
    newPrimaryEmail?: string;
    /** Required when rules are scoped only to this mailbox; otherwise ignored. */
    rules?: 'delete' | { rescopeTo: string };
  }): Promise<RemovalOutcome> {
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

    // Rules scoped only to this mailbox need a decision, and a rescope target must be live.
    // R59: an unreadable rules document never blocks a removal; the inbox_rules step below
    // then fails and is listed, so the principal knows to check the rules by hand.
    const scoped = await this.scopedRules(id);
    const rulesUnknown = scoped === null;
    const soleRules = (scoped ?? []).filter((r) => r.mailboxes!.length === 1);
    // A supplied choice is validated and kept whether or not a sole rule exists now: one may be
    // added before the cleanup reread, which then applies this choice (or, with no valid choice,
    // leaves the rules alone and reports inbox_rules incomplete).
    const choice = input.rules;
    let ruleAction: RuleRemovalAction = 'delete';
    let choiceValid = false;
    if (choice === 'delete') {
      choiceValid = true;
    } else if (choice !== undefined && typeof choice === 'object' && others.some((m) => m.id === choice.rescopeTo)) {
      ruleAction = choice;
      choiceValid = true;
    }
    if (soleRules.length > 0 || (rulesUnknown && choice !== undefined)) {
      if (choice === undefined) {
        throw new MailboxRemovalError(
          `Inbox rules (${soleRules.length}) apply only to "${id}"; choose to delete them or move them to another mailbox`,
        );
      }
      if (!choiceValid) throw new MailboxRemovalError('Move the rules to another live mailbox, or delete them');
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

    // 3. Default / tombstone in one store transaction. If it fails the mailbox stays live,
    // so the primary email goes back to what it was: a failed removal changes nothing.
    const wasDefault = rec.isDefault;
    try {
      await this.deps.store.tombstone(id, newDefault);
    } catch (err) {
      // RemovedMailboxError: another removal of this mailbox completed meanwhile, and its
      // primary-email change stands; restoring would undo it.
      if (newPrimary !== null && !(err instanceof RemovedMailboxError)) {
        try {
          await this.deps.contacts.updateContactFields(this.deps.principalContactId, { primaryEmail: primary });
        } catch (restoreErr) {
          this.log.error({ err: restoreErr, mailboxId: id }, 'Could not restore the primary email after a failed mailbox removal');
        }
      }
      this.log.error({ err, mailboxId: id }, 'Removing a principal mailbox failed; it is still live');
      throw err;
    }

    // 4-7. Past the tombstone the removal stands: each cleanup step runs on its own, a failure
    // is logged and named in the outcome, and the rest still run. The grant and the flat keys
    // go first, so a later failure cannot leave the inbox tools acting on the removed mailbox.
    const cleanupIncomplete: string[] = [];
    // `reported`: the failure's cause was already logged earlier in this removal, so it is only
    // listed (it still reaches cleanup_incomplete and the route's warn), not logged twice.
    const step = async (name: string, work: () => Promise<void>, reported: () => boolean = () => false): Promise<void> => {
      try {
        await work();
      } catch (err) {
        cleanupIncomplete.push(name);
        if (reported()) return;
        this.log.error({ ...this.safeErrFields(err), mailboxId: id, step: name }, 'Principal mailbox removed but a cleanup step failed');
      }
    };
    await step('grant_secret', () => this.deps.secrets.delete(principalMailboxGrantSecretName(id)));
    if (wasDefault) {
      await step('flat_keys', async () => {
        if (newDefault === null) return this.clearFlatKeys(id);
        const next = await this.deps.store.getAny(newDefault);
        if (!next) throw new UnknownMailboxError(newDefault);
        await this.mirrorDefaultFromVault(next);
      });
    }
    // The legacy `default` send level was set for the migrated mailbox (the only row with no
    // triage start); if its rename never landed it must not outlive that mailbox and be inherited
    // by a new sole one (R41, SF8). Removing any other mailbox leaves it alone. Its own step: a
    // failure is logged and named, the rest still run, and boot reconciles the key again.
    // Rules named for this mailbox: scoped only to it they are deleted or moved; shared ones
    // just lose the id. Runs after the grant and flat keys, so a failure here is only a rule
    // naming a mailbox that no longer exists (it matches nothing).
    const rulesDoc = this.deps.rulesDoc;
    if (rulesDoc) {
      // An unreadable document was warned about by scopedRules above; failing again is listed only.
      let unreadableAgain = false;
      await step('inbox_rules', async () => {
        let text: string | null;
        try {
          text = await rulesDoc.read();
        } catch (err) {
          unreadableAgain = rulesUnknown;
          throw err;
        }
        if (text === null) return;
        const now = parseRuleScopes(text).filter((r) => r.mailboxes?.includes(id));
        const onlyHere = now.filter((r) => r.mailboxes!.length === 1);
        // Rules scoped only here need the principal's valid choice. None was given, or the one given
        // was not valid (the first check could not read the document, or found no sole rule and
        // one was added since): do not guess. The document is left as it is and inbox_rules is
        // reported incomplete.
        if (!choiceValid && onlyHere.length > 0) {
          throw new MailboxRemovalError('Inbox rules apply only to this mailbox and no choice was given');
        }
        const next = applyRemoval(text, id, ruleAction);
        if (next === text) return;
        const doneTo = ruleAction === 'delete' ? 'deleted' : `rescoped to ${ruleAction.rescopeTo}`;
        const parts = [
          ...onlyHere.map((r) => `"${r.title}" ${doneTo}`),
          ...now.filter((r) => r.mailboxes!.length > 1).map((r) => `"${r.title}" no longer names it`),
        ];
        const summary = `mailbox ${id} removed by the principal in the console: ${parts.join('; ')}`;
        await rulesDoc.write(next, summary);
        this.log.info({ mailboxId: id, rules: parts }, 'Inbox rules rewritten for a removed mailbox');
      }, () => unreadableAgain);
    }
    if (rec.triageStartAt === null && this.deps.forgetLegacySendLevel) {
      const forget = this.deps.forgetLegacySendLevel;
      await step('legacy_send_level', () => forget());
    }
    if (!input.stillOwned) {
      await step('identity', async () => {
        if (rec.addedIdentityId) await this.deps.contacts.unlinkIdentity(rec.addedIdentityId);
        // R30: the address is no longer the principal's, whoever created its identity (a
        // migrated mailbox or an R16 pre-existing one). Inactive, not deleted: reversible.
        for (const i of principal.identities) {
          if (
            i.id !== rec.addedIdentityId &&
            i.channel === 'email' &&
            lower(i.channelIdentifier) === address &&
            i.status === 'active'
          ) {
            await this.deps.contacts.setIdentityStatus(i.id, 'defunct');
          }
        }
      });
    }
    for (const [n, hook] of (this.deps.onRemoved ?? []).entries()) await step(`on_removed_${n + 1}`, () => hook(id));
    // Always re-derive the flat keys from the registry: it repairs a failed copy above too.
    if (this.deps.reconcileFlatKeys) {
      try {
        await this.deps.reconcileFlatKeys();
        const at = cleanupIncomplete.indexOf('flat_keys');
        if (at >= 0) cleanupIncomplete.splice(at, 1);
      } catch (err) {
        if (!cleanupIncomplete.includes('flat_keys')) cleanupIncomplete.push('flat_keys');
        this.log.error({ ...this.safeErrFields(err), mailboxId: id }, 'Could not reconcile the flat keys after removing a principal mailbox');
      }
    }
    return { cleanupIncomplete, restartRequired: wasDefault };
  }

  /** Rules that name the mailbox (scoped only to it, or to it and others); null = unreadable. */
  private async scopedRules(id: string): Promise<Array<{ title: string; mailboxes: string[] | null }> | null> {
    if (!this.deps.rulesDoc) return [];
    try {
      const text = await this.deps.rulesDoc.read();
      if (text === null) return [];
      return parseRuleScopes(text).filter((r) => r.mailboxes?.includes(id));
    } catch (err) {
      this.log.warn({ ...this.safeErrFields(err), mailboxId: id }, 'Could not read the inbox rules; their scope is unknown');
      return null;
    }
  }

  private async liveTarget(id: string): Promise<{ rec: PrincipalMailboxRecord; others: PrincipalMailboxRecord[] }> {
    const rec = await this.deps.store.getAny(id);
    if (!rec) throw new UnknownMailboxError(id);
    if (rec.removedAt) throw new RemovedMailboxError(id, rec.label);
    const others = (await this.deps.store.listLive()).filter((m) => m.id !== id);
    return { rec, others };
  }

  // Mirror for ceo-inbox until Task 20 retires the flat keys (#2475). The ceo-inbox handlers
  // still read ceo_nylas_grant_id / ceo_self_email, so the default mailbox is copied there
  // whenever it changes (R28). Failures are logged (never the grant id) and rethrown.
  private async mirrorFlatKeys(id: string, grantId: string, address: string): Promise<void> {
    try {
      await this.deps.secrets.set(FLAT_GRANT_KEY, grantId);
      await this.deps.secrets.set(FLAT_EMAIL_KEY, lower(address));
    } catch (err) {
      this.log.error({ err, mailboxId: id }, 'Could not mirror the default mailbox into the flat keys');
      throw err;
    }
  }

  private async mirrorDefaultFromVault(rec: PrincipalMailboxRecord): Promise<void> {
    const grantId = await this.deps.secrets.get(principalMailboxGrantSecretName(rec.id));
    if (!grantId) {
      const err = new Error(`Mailbox "${rec.id}" has no Nylas grant in the vault`);
      this.log.error({ mailboxId: rec.id }, 'Could not mirror the default mailbox: it has no grant in the vault');
      throw err;
    }
    await this.mirrorFlatKeys(rec.id, grantId, rec.address);
  }

  private async clearFlatKeys(id: string): Promise<void> {
    try {
      await this.deps.secrets.delete(FLAT_GRANT_KEY);
      await this.deps.secrets.delete(FLAT_EMAIL_KEY);
    } catch (err) {
      this.log.error({ err, mailboxId: id }, 'Could not delete the flat mailbox keys after removing the default');
      throw err;
    }
  }

  /** Undo steps run on their own, so a failed unlink still deletes the secret and vice versa. */
  private async undoAdd(secretName: string, identityId: string | null): Promise<void> {
    if (identityId) {
      try {
        await this.deps.contacts.unlinkIdentity(identityId);
      } catch (err) {
        this.log.error({ err, identityId }, 'Could not unlink the identity of a failed mailbox add; remove it by hand in Contacts');
      }
    }
    try {
      await this.deps.secrets.delete(secretName);
    } catch (err) {
      this.log.error({ err, secretName }, 'Could not delete the grant of a failed mailbox add; clear it on the Secrets page');
    }
  }

  /**
   * A flat-key copy after a committed registry change. On failure the change still stands: the
   * flat keys are re-derived at once, and only if that fails too is a warning returned (the next
   * restart or canary repairs them). Never throws.
   */
  private async mirrorAfterCommit(id: string, mirror: () => Promise<void>): Promise<string | undefined> {
    try {
      await mirror();
      return undefined;
    } catch (err) {
      this.log.warn({ ...this.safeErrFields(err), mailboxId: id }, 'Copying the default mailbox into the flat keys failed after the change committed; reconciling');
      if (!this.deps.reconcileFlatKeys) return MIRROR_PENDING_WARNING;
      try {
        await this.deps.reconcileFlatKeys();
        this.log.info({ mailboxId: id }, 'Flat keys repaired by reconcile after a failed copy');
        return undefined;
      } catch (err) {
        this.log.error({ ...this.safeErrFields(err), mailboxId: id }, 'Flat-key reconcile after a failed copy failed too');
        return MIRROR_PENDING_WARNING;
      }
    }
  }

  /** Class and status, plus the message when the error cannot carry a grant id (R20). */
  private safeErrFields(err: unknown): Record<string, unknown> {
    return err instanceof Error && !mayCarryGrantId(err)
      ? { ...grantSafeErrorFields(err), errMessage: err.message }
      : { ...grantSafeErrorFields(err) };
  }
}
