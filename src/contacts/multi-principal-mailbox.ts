// multi-principal-mailbox.ts — PrincipalMailbox over every live principal mailbox (#2475).
//
// "Has the principal ever written to this person?" is true if ANY of their mailboxes has a sent
// message to the address. Mailboxes are resolved per call through the service, so a replaced
// grant applies without a restart. Each mailbox is searched in parallel with its own deadline
// (this runs inside dispatch, ahead of the coordinator, like NylasPrincipalMailbox).
//
//   any mailbox true            -> true
//   every mailbox failed        -> throws (the acquaintance check's "unknown", not "no")
//   otherwise                   -> false
//
// A mailbox that failed while another answered false still leaves the answer false: one
// readable mailbox with no correspondence is the evidence we have. Logs carry the mailbox id and
// error class only, never a grant id (R20).

import type { Logger } from '../logger.js';
import type { NylasClient } from '../channels/email/nylas-client.js';
import type { PrincipalMailboxes } from '../principal-mailboxes/service.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';
import { isPlainAddress, type PrincipalMailbox } from './principal-acquaintance.js';

const LOOKUP_TIMEOUT_MS = 5_000;
// A few results, not one: each hit is checked for the address among its recipients, since
// any_email would also match the address as a sender.
const LOOKUP_LIMIT = 5;
const SENT_ATTRIBUTE = '\\Sent';

export class MultiPrincipalMailbox implements PrincipalMailbox {
  constructor(
    private readonly mailboxes: Pick<PrincipalMailboxes, 'list' | 'gatewayClient'>,
    private readonly logger: Logger,
    private readonly timeoutMs = LOOKUP_TIMEOUT_MS,
  ) {}

  async hasSentTo(address: string): Promise<boolean> {
    // The caller already checks this; repeated here because the value goes into a query.
    if (!isPlainAddress(address)) return false;
    const live = await this.mailboxes.list();
    // Nothing connected: no evidence either way, and nothing failed.
    if (live.length === 0) return false;
    const settled = await Promise.all(
      live.map(async (m): Promise<'yes' | 'no' | 'failed'> => {
        try {
          return (await this.withDeadline(m.id, address)) ? 'yes' : 'no';
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

  private async withDeadline(mailboxId: string, address: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`principal mailbox lookup timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      return await Promise.race([this.searchSent(mailboxId, address), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async searchSent(mailboxId: string, address: string): Promise<boolean> {
    // The same SDK timeout as the race, so the request is aborted at the deadline too.
    const client: NylasClient = await this.mailboxes.gatewayClient(mailboxId, this.timeoutMs);
    const sent = (await client.listFolders()).find((f) => f.attributes?.includes(SENT_ATTRIBUTE));
    // Thrown, not false: a mailbox with no Sent folder found is one we can't read.
    if (!sent) throw new Error('principal mailbox has no folder with the \\Sent attribute');
    const messages = await client.listMessages({ folders: [sent.id], anyEmail: address, limit: LOOKUP_LIMIT });
    const wanted = address.toLowerCase();
    return messages.some((m) => [...m.to, ...m.cc].some((p) => p.email.trim().toLowerCase() === wanted));
  }
}
