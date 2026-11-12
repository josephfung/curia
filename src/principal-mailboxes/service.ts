// PrincipalMailboxes — resolves the principal's Gmail mailboxes (#2475).
// Reads the registry (store) for what exists and the vault for each mailbox's grant.
// Grants are read on every call and clients are built per call (no cache), so a grant
// change applies without a restart. An unknown or removed id is an error, never a
// fallback to the default mailbox.
//
// Deliberately does not import channels/calendar/resolve-calendar-grant.ts (R9).
import type { Logger } from '../logger.js';
import { NylasClient } from '../channels/email/nylas-client.js';
import { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';
import type { PrincipalMailboxStore } from './store.js';
import { principalMailboxGrantSecretName } from './secrets.js';
import {
  MissingNylasApiKeyError,
  RemovedMailboxError,
  UnknownMailboxError,
  type PrincipalMailboxRecord,
} from './types.js';

/** The flat grant the deferred-migration fallback serves (#2409). */
const FLAT_GRANT_KEY = 'ceo_nylas_grant_id';

export interface PrincipalMailboxView {
  id: string;
  label: string;
  /** Empty string when unknown: the deferred single-mailbox fallback has no registry row,
   *  so its address has not been read from Nylas. */
  address: string;
  isDefault: boolean;
  triageStartAt: Date | null;
}

export interface PrincipalMailboxesDeps {
  store: PrincipalMailboxStore;
  secrets: { get(name: string): Promise<string | null> };
  apiKey: () => string | undefined;
  logger: Logger;
  createNylasClient?: (apiKey: string, grantId: string) => NylasClient;
  createCalendarClient?: (apiKey: string, grantId: string) => NylasCalendarClient;
  /** The principal's verified, active email identity addresses (R32). Absent: mailboxes only. */
  principalEmailIdentities?: () => Promise<string[]>;
}

function toView(r: PrincipalMailboxRecord): PrincipalMailboxView {
  return {
    id: r.id,
    label: r.label,
    address: r.address,
    isDefault: r.isDefault,
    triageStartAt: r.triageStartAt,
  };
}

export class PrincipalMailboxes {
  private fallback: { id: string; grantId: string } | null = null;
  /** Why the flat mailbox is still not in the registry, for the console and health. */
  private migrationReason: string | null = null;
  private readonly log: Logger;

  constructor(private readonly deps: PrincipalMailboxesDeps) {
    this.log = deps.logger.child({ component: 'principal-mailboxes' });
  }

  /** Single-mailbox installs without a registry row: serve `fallback` while the table is empty.
   *  Its grant is re-read from `ceo_nylas_grant_id` on every call; `grantId` is the boot value. */
  setFallback(f: { id: string; grantId: string } | null): void {
    this.fallback = f;
    if (f === null) this.migrationReason = null;
  }

  /** Records why the last migration attempt left the flat mailbox out of the registry. */
  setPendingMigrationReason(reason: string | null): void {
    this.migrationReason = reason;
  }

  /** Why the deferred mailbox is not migrated yet; null when no fallback is served or no reason is known. */
  pendingMigrationReason(): string | null {
    return this.fallback ? this.migrationReason : null;
  }

  private fallbackView(): PrincipalMailboxView | null {
    if (!this.fallback) return null;
    return { id: this.fallback.id, label: 'Mailbox', address: '', isDefault: true, triageStartAt: null };
  }

  /**
   * The fallback is served only when one is set AND the table has no rows at all, live or
   * removed. Otherwise its id is unknown like any other, and a registry row always wins.
   */
  private async activeFallback(): Promise<{ id: string; grantId: string } | null> {
    if (!this.fallback) return null;
    return (await this.deps.store.hasAnyRow()) ? null : this.fallback;
  }

  /** True while the deferred-migration fallback is being served (no registry rows at all). */
  async isFallbackActive(): Promise<boolean> {
    return (await this.activeFallback()) !== null;
  }

  /** Live mailboxes only; the fallback view when it is active. */
  async list(): Promise<PrincipalMailboxView[]> {
    const live = await this.deps.store.listLive();
    if (live.length > 0) return live.map(toView);
    if (await this.activeFallback()) return [this.fallbackView()!];
    return [];
  }

  async get(id: string): Promise<PrincipalMailboxView> {
    const rec = await this.deps.store.getAny(id);
    if (rec) {
      if (rec.removedAt) throw new RemovedMailboxError(id, rec.label);
      return toView(rec);
    }
    const fb = await this.activeFallback();
    if (fb && fb.id === id) return this.fallbackView()!;
    throw new UnknownMailboxError(id);
  }

  async defaultMailbox(): Promise<PrincipalMailboxView | null> {
    const all = await this.list();
    return all.find((m) => m.isDefault) ?? null;
  }

  /** Addresses of live mailboxes (the fallback's unknown address is omitted). */
  async addresses(): Promise<string[]> {
    return (await this.list()).map((m) => m.address).filter((a) => a !== '');
  }

  /**
   * Every address that is the principal's own: live mailbox addresses plus the principal's
   * verified, active email identities (a defunct or bounced one is no longer theirs, R32).
   * Lowercase, deduplicated, no empty strings.
   */
  async principalEmailAddresses(): Promise<string[]> {
    const fromIdentities = this.deps.principalEmailIdentities ? await this.deps.principalEmailIdentities() : [];
    const all = [...(await this.addresses()), ...fromIdentities]
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a !== '');
    return [...new Set(all)];
  }

  async credentials(id: string): Promise<{ apiKey: string; grantId: string }> {
    const rec = await this.deps.store.getAny(id);
    if (rec?.removedAt) throw new RemovedMailboxError(id, rec.label);
    const apiKey = this.deps.apiKey();
    if (!apiKey) throw new MissingNylasApiKeyError();

    if (!rec) {
      const fb = await this.activeFallback();
      if (!fb || fb.id !== id) throw new UnknownMailboxError(id);
      // Read live, as for a registry mailbox: while the registry is empty the vault still
      // accepts a new flat grant, and it must apply without a restart (R9).
      const flatGrant = (await this.deps.secrets.get(FLAT_GRANT_KEY))?.trim();
      if (!flatGrant) {
        this.log.warn({ mailboxId: id }, 'The deferred mailbox has no ceo_nylas_grant_id in the vault');
        throw new Error(`Mailbox "${id}" has no Nylas grant configured`);
      }
      return { apiKey, grantId: flatGrant };
    }

    const grantId = await this.deps.secrets.get(principalMailboxGrantSecretName(id));
    if (!grantId) {
      this.log.warn({ mailboxId: id }, 'Principal mailbox has no Nylas grant in the vault');
      throw new Error(`Mailbox "${id}" has no Nylas grant configured`);
    }
    return { apiKey, grantId };
  }

  async gatewayClient(id: string): Promise<NylasClient> {
    const { apiKey, grantId } = await this.credentials(id);
    return this.deps.createNylasClient
      ? this.deps.createNylasClient(apiKey, grantId)
      : new NylasClient(apiKey, grantId, this.deps.logger);
  }

  async calendarClient(id: string): Promise<NylasCalendarClient> {
    const { apiKey, grantId } = await this.credentials(id);
    return this.deps.createCalendarClient
      ? this.deps.createCalendarClient(apiKey, grantId)
      : new NylasCalendarClient(apiKey, grantId, this.deps.logger);
  }
}
