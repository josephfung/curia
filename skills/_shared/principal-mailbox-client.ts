// Per-mailbox Nylas clients for the ceo-inbox tools (#2475).
// Clients always come from ctx.principalMailboxes (which holds no credentials); there is deliberately no
// fallback to the flat ceo_nylas_grant_id secret. Grant ids never appear in errors or logs.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView, SkillPrincipalMailboxes } from '../../src/principal-mailboxes/service.js';
import type { ErrorType } from '../../src/errors/types.js';
import { messageNotFoundError, nylasStatus } from '../../src/channels/email/nylas-message-id.js';
import { CeoNylasClient } from './ceo-nylas-client.js';
import { judgeHolders } from '../../src/principal-mailboxes/locate-holder.js';
import { MissingNylasApiKeyError, RemovedMailboxError, UnknownMailboxError } from '../../src/principal-mailboxes/types.js';

export interface MailboxClient {
  mailbox: PrincipalMailboxView;
  client: CeoNylasClient;
}

export type LocateResult =
  | { kind: 'found'; at: MailboxClient }
  | { kind: 'not_found'; definitive: boolean; failed: Array<{ mailboxId: string; detail: string }> }
  | { kind: 'ambiguous'; mailboxes: PrincipalMailboxView[] }
  | { kind: 'no_mailboxes' };

function service(ctx: ToolContext): SkillPrincipalMailboxes {
  if (!ctx.principalMailboxes) {
    throw new Error('This tool needs the principalMailboxes capability, which is not available');
  }
  return ctx.principalMailboxes;
}

async function build(ctx: ToolContext, svc: SkillPrincipalMailboxes, mailbox: PrincipalMailboxView): Promise<MailboxClient> {
  // The service builds the client: the key and grant id stay on its side.
  return { mailbox, client: await svc.ceoClient(mailbox.id, ctx.log, ctx) };
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

/**
 * Every live mailbox, each with a client or the reason it has none. One mailbox whose credentials
 * cannot be read does not hide the others. The reason is an error class name, never a grant id.
 */
export async function settledMailboxClients(
  ctx: ToolContext,
): Promise<Array<{ mailbox: PrincipalMailboxView; at?: MailboxClient; failure?: string }>> {
  const svc = service(ctx);
  const mailboxes = await svc.list();
  return Promise.all(
    mailboxes.map(async (m) => {
      try {
        return { mailbox: m, at: await build(ctx, svc, m) };
      } catch (err) {
        const name = err instanceof Error ? err.constructor.name : 'Error';
        ctx.log.warn({ mailboxId: m.id, errorName: name }, 'mailbox client unavailable');
        return { mailbox: m, failure: name };
      }
    }),
  );
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
 * a 404 is a definitive miss. Otherwise every live mailbox is asked in parallel; a mailbox whose
 * client cannot be built or whose probe fails (not a 404) goes into `failed` and makes a miss
 * non-definitive. No live mailbox at all returns `no_mailboxes`.
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

  const verdict = judgeHolders(results.map((r) => ({
    candidate: r.at,
    outcome: r.result.ok ? ('hit' as const) : r.result.notFound ? ('miss' as const) : ('failed' as const),
  })));
  if (verdict.kind === 'found') return { kind: 'found', at: verdict.holder };
  if (verdict.kind === 'ambiguous') return { kind: 'ambiguous', mailboxes: verdict.holders.map((h) => h.mailbox) };

  for (const at of verdict.failed) {
    const r = results.find((x) => x.at === at)!.result;
    if (!r.ok) failed.push({ mailboxId: at.mailbox.id, detail: r.detail });
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

export type MailboxPick = { ok: true; at: MailboxClient } | { ok: false; error: string; errorType?: ErrorType };

/** The tool's optional `mailbox` input: undefined when omitted, an error for anything but a string. */
export function readMailboxInput(input: unknown): { ok: true; mailbox: string | undefined } | { ok: false; error: string } {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)['mailbox'] : undefined;
  if (raw === undefined || raw === null) return { ok: true, mailbox: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'mailbox must be a mailbox id (string)' };
  return { ok: true, mailbox: raw };
}

/** A message safe to hand the model for a failed mailbox lookup. Never carries a grant id. */
function mailboxFailureMessage(err: unknown): string {
  if (err instanceof UnknownMailboxError || err instanceof RemovedMailboxError || err instanceof MissingNylasApiKeyError) {
    return err.message;
  }
  return 'The principal mailbox is unavailable.';
}

function failMailbox(ctx: ToolContext, tool: string, err: unknown): { ok: false; error: string } {
  ctx.log.error({ err, tool }, `${tool}: could not resolve the principal mailbox`);
  return { ok: false, error: mailboxFailureMessage(err) };
}

/**
 * The mailbox a tool acts in when it does not search for an object: the named one, validated
 * (unknown or removed ids are errors, never the default), otherwise the default mailbox.
 * Never throws.
 */
export async function namedOrDefaultMailbox(ctx: ToolContext, input: unknown, tool: string): Promise<MailboxPick> {
  const parsed = readMailboxInput(input);
  if (!parsed.ok) return parsed;
  try {
    if (parsed.mailbox !== undefined) return { ok: true, at: await mailboxClient(ctx, parsed.mailbox) };
    const def = await service(ctx).defaultMailbox();
    if (!def) return { ok: false, error: 'No principal mailbox is connected.' };
    return { ok: true, at: await mailboxClient(ctx, def.id) };
  } catch (err) {
    return failMailbox(ctx, tool, err);
  }
}

/** Find the mailbox holding a message or draft, honouring an explicit `mailbox` input. Never throws. */
export async function locateInMailbox(
  ctx: ToolContext,
  input: unknown,
  tool: string,
  kind: 'message' | 'draft',
  objectId: string,
): Promise<MailboxPick> {
  const parsed = readMailboxInput(input);
  if (!parsed.ok) return parsed;
  try {
    const found = await locate(ctx, kind, objectId, parsed.mailbox);
    if (found.kind === 'found') return { ok: true, at: found.at };
    // A definite miss for a message keeps the "do not retry with this ID" wording the model acts on.
    if (kind === 'message' && found.kind === 'not_found' && found.definitive) {
      return { ok: false, error: messageNotFoundError(objectId), errorType: 'NOT_FOUND' };
    }
    return { ok: false, error: locateError(found, kind) };
  } catch (err) {
    return failMailbox(ctx, tool, err);
  }
}

/**
 * For tools that do not act in a mailbox yet: a given `mailbox` must still name a live one.
 * Returns an error string, or null when the input is fine (or omitted). Never throws.
 */
export async function checkMailboxInput(ctx: ToolContext, input: unknown, tool: string): Promise<string | null> {
  const parsed = readMailboxInput(input);
  if (!parsed.ok) return parsed.error;
  if (parsed.mailbox === undefined) return null;
  try {
    await service(ctx).get(parsed.mailbox);
    return null;
  } catch (err) {
    return failMailbox(ctx, tool, err).error;
  }
}
