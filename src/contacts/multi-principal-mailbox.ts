// multi-principal-mailbox.ts — PrincipalMailbox over every live principal mailbox (#2475).
//
// "Has the principal ever written to this person?" is true if ANY of their mailboxes has a sent
// message to the address. Grants are read per call, so a replaced grant applies without a
// restart; the client is kept per mailbox and rebuilt only when its grant changes (B7, as
// createPrincipalMailboxResolver does), so its folder cache survives between lookups. Each mailbox
// is searched in parallel with its own deadline, and so is the mailbox list itself (this runs
// inside dispatch, ahead of the coordinator).
//
//   any mailbox true            -> true
//   every mailbox failed        -> throws (the acquaintance check's "unknown", not "no")
//   no live mailbox             -> false (see hasSentTo)
//   otherwise                   -> false
//
// A mailbox that failed while another answered false still leaves the answer false: one
// readable mailbox with no correspondence is the evidence we have. Logs carry the mailbox id and
// error class only, never a grant id (R20).

import type { Logger } from '../logger.js';
import { NylasClient } from '../channels/email/nylas-client.js';
import type { PrincipalMailboxes } from '../principal-mailboxes/service.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';
import { isPlainAddress, type PrincipalMailbox } from './principal-acquaintance.js';

const LOOKUP_TIMEOUT_MS = 5_000;
// A few results, not one: each hit is checked for the address among its recipients, since
// any_email would also match the address as a sender.
const LOOKUP_LIMIT = 5;
const SENT_ATTRIBUTE = '\\Sent';

export class MultiPrincipalMailbox implements PrincipalMailbox {
  private readonly clients = new Map<string, { key: string; grantId: string; client: NylasClient }>();
  private readonly createClient: (apiKey: string, grantId: string, timeoutMs: number) => NylasClient;

  constructor(
    private readonly mailboxes: Pick<PrincipalMailboxes, 'list' | 'credentials'>,
    private readonly logger: Logger,
    private readonly timeoutMs = LOOKUP_TIMEOUT_MS,
    createClient?: (apiKey: string, grantId: string, timeoutMs: number) => NylasClient,
  ) {
    this.createClient = createClient ?? ((key, grant, ms) => new NylasClient(key, grant, logger, ms));
  }

  async hasSentTo(address: string): Promise<boolean> {
    // The caller already checks this; repeated here because the value goes into a query.
    if (!isPlainAddress(address)) return false;
    // Under the same deadline as the searches (item 10): a hung registry read must not stall dispatch.
    const live = await this.withDeadline(this.mailboxes.list(), 'principal mailbox list');
    // Nothing connected: no evidence either way, and nothing failed. Answered false (and so cached
    // for the acquaintance TTL), not thrown: an install with a Nylas key and no principal mailbox
    // is a steady state, and a throw would log a warning on every unknown sender. A mailbox added
    // meanwhile is consulted once that hour's cache entry expires.
    if (live.length === 0) return false;
    const settled = await Promise.all(
      live.map(async (m): Promise<'yes' | 'no' | 'failed'> => {
        try {
          return (await this.withDeadline(this.searchSent(m.id, address), 'principal mailbox lookup')) ? 'yes' : 'no';
        } catch (err) {
          this.logger.warn({ mailboxId: m.id, ...grantSafeErrorFields(err) }, 'principal acquaintance: one mailbox could not be searched');
          return 'failed';
        }
      }),
    );
    if (settled.includes('yes')) return true;
    if (settled.every((s) => s === 'failed')) {
      throw new Error(`none of the ${live.length} principal mailbox(es) could be searched`);
    }
    return false;
  }

  private async withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${what} timed out after ${this.timeoutMs}ms`);
        err.name = 'TimeoutError';
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The mailbox's client, reused while its key and grant are unchanged. */
  private async clientFor(mailboxId: string): Promise<NylasClient> {
    const { apiKey: key, grantId } = await this.mailboxes.credentials(mailboxId);
    const hit = this.clients.get(mailboxId);
    if (hit && hit.key === key && hit.grantId === grantId) return hit.client;
    // The same SDK timeout as the race, so the request is aborted at the deadline too.
    const client = this.createClient(key, grantId, this.timeoutMs);
    this.clients.set(mailboxId, { key, grantId, client });
    return client;
  }

  private async searchSent(mailboxId: string, address: string): Promise<boolean> {
    const client = await this.clientFor(mailboxId);
    const sent = (await client.listFolders()).find((f) => f.attributes?.includes(SENT_ATTRIBUTE));
    // Thrown, not false: a mailbox with no Sent folder found is one we can't read.
    if (!sent) throw new Error('principal mailbox has no folder with the \\Sent attribute');
    const messages = await client.listMessages({ folders: [sent.id], anyEmail: address, limit: LOOKUP_LIMIT });
    const wanted = address.toLowerCase();
    return messages.some((m) => [...m.to, ...m.cc].some((p) => p.email.trim().toLowerCase() === wanted));
  }
}
