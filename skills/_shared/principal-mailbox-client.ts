// Per-mailbox Nylas clients for the ceo-inbox tools (#2475).
// Credentials always come from ctx.principalMailboxes; there is deliberately no
// fallback to the flat ceo_nylas_grant_id secret. Grant ids never appear in errors or logs.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView, PrincipalMailboxes } from '../../src/principal-mailboxes/service.js';
import { nylasStatus } from '../../src/channels/email/nylas-message-id.js';
import { CeoNylasClient } from './ceo-nylas-client.js';

export interface MailboxClient {
  mailbox: PrincipalMailboxView;
  client: CeoNylasClient;
}

export type LocateResult =
  | { kind: 'found'; at: MailboxClient }
  | { kind: 'not_found'; definitive: boolean; failed: Array<{ mailboxId: string; detail: string }> }
  | { kind: 'ambiguous'; mailboxes: PrincipalMailboxView[] }
  | { kind: 'no_mailboxes' };

function service(ctx: ToolContext): PrincipalMailboxes {
  if (!ctx.principalMailboxes) {
    throw new Error('This tool needs the principalMailboxes capability, which is not available');
  }
  return ctx.principalMailboxes;
}

async function build(ctx: ToolContext, svc: PrincipalMailboxes, mailbox: PrincipalMailboxView): Promise<MailboxClient> {
  const { apiKey, grantId } = await svc.credentials(mailbox.id);
  return { mailbox, client: new CeoNylasClient(apiKey, grantId, ctx.log, ctx) };
}

/** Client for one live mailbox. Throws UnknownMailboxError / RemovedMailboxError for a bad id. */
export async function mailboxClient(ctx: ToolContext, mailboxId: string): Promise<MailboxClient> {
  const svc = service(ctx);
  const mailbox = await svc.get(mailboxId);
  return build(ctx, svc, mailbox);
}

/** Clients for every live mailbox. */
export async function allMailboxClients(ctx: ToolContext): Promise<MailboxClient[]> {
  const svc = service(ctx);
  const mailboxes = await svc.list();
  return Promise.all(mailboxes.map((m) => build(ctx, svc, m)));
}

type Probe = { ok: true } | { ok: false; notFound: boolean; detail: string };

async function probe(at: MailboxClient, kind: 'message' | 'draft', objectId: string): Promise<Probe> {
  try {
    if (kind === 'message') await at.client.getMessage(objectId);
    else await at.client.getDraft(objectId);
    return { ok: true };
  } catch (err) {
    if (nylasStatus(err) === 404) return { ok: false, notFound: true, detail: 'not found' };
    const status = nylasStatus(err);
    return { ok: false, notFound: false, detail: status !== undefined ? `HTTP ${status}` : 'request failed' };
  }
}

/**
 * Find the mailbox holding a message or draft. With an explicit mailbox, one GET there and
 * a 404 is a definitive miss. Otherwise every live mailbox is asked in parallel.
 */
export async function locate(
  ctx: ToolContext,
  kind: 'message' | 'draft',
  objectId: string,
  explicitMailbox?: string,
): Promise<LocateResult> {
  const failed: Array<{ mailboxId: string; detail: string }> = [];
  let candidates: MailboxClient[];
  if (explicitMailbox !== undefined) {
    // A blank id is an unknown id, thrown by the service like any other.
    candidates = [await mailboxClient(ctx, explicitMailbox)];
  } else {
    const svc = service(ctx);
    const mailboxes = await svc.list();
    if (mailboxes.length === 0) return { kind: 'no_mailboxes' };
    candidates = [];
    await Promise.all(
      mailboxes.map(async (m) => {
        try {
          candidates.push(await build(ctx, svc, m));
        } catch (err) {
          // Credentials or client construction failed for this mailbox only; keep probing the rest.
          const name = err instanceof Error ? err.constructor.name : 'Error';
          ctx.log.warn({ mailboxId: m.id, errorName: name }, 'locate: mailbox client unavailable');
          failed.push({ mailboxId: m.id, detail: name });
        }
      }),
    );
  }

  const results = await Promise.all(
    candidates.map(async (at) => ({ at, result: await probe(at, kind, objectId) })),
  );

  const hits = results.filter((r) => r.result.ok);
  if (hits.length === 1) return { kind: 'found', at: hits[0]!.at };
  if (hits.length > 1) return { kind: 'ambiguous', mailboxes: hits.map((h) => h.at.mailbox) };

  for (const { at, result } of results) {
    if (!result.ok && !result.notFound) failed.push({ mailboxId: at.mailbox.id, detail: result.detail });
  }
  return { kind: 'not_found', definitive: failed.length === 0, failed };
}

export function mailboxFields(m: PrincipalMailboxView): { mailbox: string; mailbox_label: string } {
  return { mailbox: m.id, mailbox_label: m.label };
}

export function locateError(r: Exclude<LocateResult, { kind: 'found' }>, noun: string): string {
  if (r.kind === 'no_mailboxes') return 'No principal mailbox is connected.';
  if (r.kind === 'ambiguous') {
    const labels = r.mailboxes.map((m) => `${m.label} (${m.id})`).join(', ');
    return `That ${noun} exists in more than one mailbox: ${labels}. Say which one with the mailbox argument.`;
  }
  if (r.definitive) return `No such ${noun} was found.`;
  const ids = r.failed.map((f) => f.mailboxId).join(', ');
  return `No such ${noun} was found, but I could not check mailbox ${ids}, so it may be there. Try again shortly.`;
}
