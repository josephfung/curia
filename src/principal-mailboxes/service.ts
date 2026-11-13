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
import { CeoNylasClient } from '../channels/email/ceo-nylas-client.js';
import type { CallBudget } from '../util/call-budget.js';
import type { PrincipalMailboxStore } from './store.js';
import { principalMailboxGrantSecretName } from './secrets.js';
import { countsOnly, mailboxEvidence, type CountsOnlyEvidence } from './evidence.js';
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
  createNylasClient?: (apiKey: string, grantId: string, timeoutMs?: number) => NylasClient;
  createCalendarClient?: (apiKey: string, grantId: string) => NylasCalendarClient;
  /** The principal's verified, active email identity addresses (R32). Absent: mailboxes only. */
  principalEmailIdentities?: () => Promise<string[]>;
}

/** The list-only `mailboxDirectory` view (#2475): each live mailbox's id, label and triage start. */
export interface MailboxDirectory {
  list(): Promise<Array<{ id: string; label: string; triageStartAt: Date | null }>>;
}

/**
 * What a skill gets as `ctx.principalMailboxes` (security finding F7). The registry reads and a
 * ready client per mailbox, and nothing that returns the Nylas API key or a grant id: those never
 * cross into skill code. Built by `forSkills`, as a plain object of methods rather than the class.
 */
export interface SkillPrincipalMailboxes {
  list(): Promise<PrincipalMailboxView[]>;
  get(id: string): Promise<PrincipalMailboxView>;
  defaultMailbox(): Promise<PrincipalMailboxView | null>;
  /** True while the deferred-migration fallback is served (no registry rows): per-mailbox state keeps the global keys. */
  isFallbackActive(): Promise<boolean>;
  principalEmailAddresses(): Promise<string[]>;
  /** The Nylas SDK client for one live mailbox. */
  gatewayClient(id: string): Promise<NylasClient>;
  /** The ceo-inbox REST client for one live mailbox, bound to the tool call's budget. */
  ceoClient(id: string, log: Logger, budget?: CallBudget): Promise<CeoNylasClient>;
}

/** What the calendar router reads: the registry and a calendar client per live mailbox. */
export interface CalendarRouterMailboxes {
  list(): Promise<PrincipalMailboxView[]>;
  get(id: string): Promise<PrincipalMailboxView>;
  isFallbackActive(): Promise<boolean>;
  calendarClient(id: string): Promise<NylasCalendarClient>;
  /**
   * Which mailbox has a history with these attendees (D5), for the calendar write gate. Mail is
   * read here, in code; the calendar tools get the counts, never a mail client.
   */
  evidence(recipients: string[]): Promise<CountsOnlyEvidence[]>;
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

  /** `timeoutMs`: an SDK request timeout for callers with a deadline (default: the SDK's). */
  async gatewayClient(id: string, timeoutMs?: number): Promise<NylasClient> {
    const { apiKey, grantId } = await this.credentials(id);
    return this.deps.createNylasClient
      ? (timeoutMs === undefined
        ? this.deps.createNylasClient(apiKey, grantId)
        : this.deps.createNylasClient(apiKey, grantId, timeoutMs))
      : new NylasClient(apiKey, grantId, this.deps.logger, timeoutMs);
  }

  /** A ceo-inbox client for one mailbox: the key and grant are read here and never returned. */
  async ceoClient(id: string, log: Logger, budget?: CallBudget): Promise<CeoNylasClient> {
    const { apiKey, grantId } = await this.credentials(id);
    return new CeoNylasClient(apiKey, grantId, log, budget);
  }

  /**
   * The narrowed view skills receive. Each member forwards to this instance, so there is no
   * `credentials` member to reach, and the object holds no reference to the class itself.
   */
  forSkills(): SkillPrincipalMailboxes {
    return {
      list: () => this.list(),
      get: (id) => this.get(id),
      defaultMailbox: () => this.defaultMailbox(),
      isFallbackActive: () => this.isFallbackActive(),
      principalEmailAddresses: () => this.principalEmailAddresses(),
      gatewayClient: (id) => this.gatewayClient(id),
      ceoClient: (id, log, budget) => this.ceoClient(id, log, budget),
    };
  }

  /** The list-only view for skills that only name mailboxes. Holds nothing but this method. */
  forDirectory(): MailboxDirectory {
    return {
      list: async () => (await this.list()).map(({ id, label, triageStartAt }) => ({ id, label, triageStartAt })),
    };
  }

  /**
   * The view the calendar router holds (#2475, Part 4). The router is handed to skills as the
   * `calendarRouter` capability, so like `forSkills` it gets closures, never this instance or
   * `credentials` (F7).
   */
  forCalendarRouter(): CalendarRouterMailboxes {
    return {
      list: () => this.list(),
      get: (id) => this.get(id),
      isFallbackActive: () => this.isFallbackActive(),
      calendarClient: (id) => this.calendarClient(id),
      // Counts and domain match only (R81): no subjects or dates of the principal's mail.
      evidence: async (recipients) =>
        (await mailboxEvidence({ list: () => this.list(), gatewayClient: (id) => this.gatewayClient(id) }, recipients, { log: this.log }))
          .map(countsOnly),
    };
  }

  async calendarClient(id: string): Promise<NylasCalendarClient> {
    const { apiKey, grantId } = await this.credentials(id);
    return this.deps.createCalendarClient
      ? this.deps.createCalendarClient(apiKey, grantId)
      : new NylasCalendarClient(apiKey, grantId, this.deps.logger);
  }
}
