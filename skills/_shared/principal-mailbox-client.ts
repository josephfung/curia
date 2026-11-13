// Per-mailbox Nylas clients for the ceo-inbox tools (#2475).
// Clients always come from ctx.principalMailboxes (which holds no credentials); there is deliberately no
// fallback to a grant read straight from the vault. Grant ids never appear in errors or logs.

import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView, SkillPrincipalMailboxes } from '../../src/principal-mailboxes/service.js';
import type { ErrorType } from '../../src/errors/types.js';
import { messageNotFoundError, nylasStatus } from '../../src/channels/email/nylas-message-id.js';
import { CeoNylasClient } from './ceo-nylas-client.js';
import { judgeHolders } from '../../src/principal-mailboxes/locate-holder.js';
import { MissingNylasApiKeyError, RemovedMailboxError, UnknownMailboxError } from '../../src/principal-mailboxes/types.js';
import { grantSafeErrorFields } from '../../src/principal-mailboxes/error-fields.js';

export interface MailboxClient {
  mailbox: PrincipalMailboxView;
  client: CeoNylasClient;
}

/** A mailbox that could not be asked: its label (what the model relays), and the HTTP status when there was one. */
export interface LocateFailure {
  mailboxId: string;
  label: string;
  detail: string;
  status?: number;
}

export type LocateResult =
  | { kind: 'found'; at: MailboxClient }
  /** `missed`: mailboxes that answered 404. `failed`: mailboxes that could not be asked. */
  | { kind: 'not_found'; definitive: boolean; missed: number; failed: LocateFailure[] }
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

type Probe = { ok: true } | { ok: false; notFound: boolean; detail: string; status?: number };

async function probe(ctx: ToolContext, tool: string, at: MailboxClient, kind: 'message' | 'draft', objectId: string): Promise<Probe> {
  try {
    if (kind === 'message') await at.client.getMessage(objectId);
    else await at.client.getDraft(objectId);
    return { ok: true };
  } catch (err) {
    const status = nylasStatus(err);
    if (status === 404) return { ok: false, notFound: true, detail: 'not found' };
    // Not a miss: this mailbox could not be asked (SF4). Class and status only, never the body.
    ctx.log.warn({ tool, mailboxId: at.mailbox.id, ...grantSafeErrorFields(err), ...(status !== undefined ? { status } : {}) }, `${tool}: mailbox could not be asked for the ${kind}`);
    return { ok: false, notFound: false, detail: status !== undefined ? `HTTP ${status}` : 'request failed', ...(status !== undefined ? { status } : {}) };
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
  tool = 'locate',
): Promise<LocateResult> {
  const failed: LocateFailure[] = [];
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
          ctx.log.warn({ tool, mailboxId: m.id, errorName: name }, 'locate: mailbox client unavailable');
          failed.push({ mailboxId: m.id, label: m.label, detail: name });
        }
      }),
    );
  }

  const results = await Promise.all(
    candidates.map(async (at) => ({ at, result: await probe(ctx, tool, at, kind, objectId) })),
  );

  const verdict = judgeHolders(results.map((r) => ({
    candidate: r.at,
    outcome: r.result.ok ? ('hit' as const) : r.result.notFound ? ('miss' as const) : ('failed' as const),
  })));
  if (verdict.kind === 'found') return { kind: 'found', at: verdict.holder };
  if (verdict.kind === 'ambiguous') return { kind: 'ambiguous', mailboxes: verdict.holders.map((h) => h.mailbox) };

  for (const at of verdict.failed) {
    const r = results.find((x) => x.at === at)!.result;
    if (!r.ok) failed.push({ mailboxId: at.mailbox.id, label: at.mailbox.label, detail: r.detail, ...(r.status !== undefined ? { status: r.status } : {}) });
  }
  const missed = results.filter((x) => !x.result.ok && x.result.notFound).length;
  return { kind: 'not_found', definitive: failed.length === 0, missed, failed };
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
  const which = r.failed.map((f) => `${f.label} (${f.detail})`).join(', ');
  if (r.missed === 0) {
    // Nothing answered "not there": an access failure, not a miss (SF2). Labels, never ids.
    const auth = r.failed.some((f) => f.status === 401 || f.status === 403);
    const plural = r.failed.length > 1 ? 'mailboxes' : 'mailbox';
    return `Couldn't reach the ${which} ${plural}; ${auth ? 'it may need reconnecting' : 'try again shortly'}.`;
  }
  return `No such ${noun} was found, but I could not check the ${which} mailbox, so it may be there. Try again shortly.`;
}

/** RATE_LIMIT when every mailbox that could not be asked answered 429 (SF2). */
function locateErrorType(r: Exclude<LocateResult, { kind: 'found' }>): ErrorType | undefined {
  if (r.kind !== 'not_found' || r.failed.length === 0) return undefined;
  return r.failed.every((f) => f.status === 429) ? 'RATE_LIMIT' : undefined;
}

export type MailboxPick = { ok: true; at: MailboxClient } | { ok: false; error: string; errorType?: ErrorType };

/** The tool's optional `mailbox` input: undefined when omitted, an error for anything but a string. */
export function readMailboxInput(input: unknown): { ok: true; mailbox: string | undefined } | { ok: false; error: string } {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>)['mailbox'] : undefined;
  if (raw === undefined || raw === null) return { ok: true, mailbox: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'mailbox must be a mailbox id (string)' };
  return { ok: true, mailbox: raw };
}

/** A live mailbox's label for a message, or its id when the label can't be read. Never throws. */
async function mailboxLabel(ctx: ToolContext, mailboxId: string): Promise<string> {
  try {
    return (await service(ctx).get(mailboxId)).label;
  } catch (err) {
    ctx.log.debug({ mailboxId, ...grantSafeErrorFields(err) }, 'mailbox label unreadable; naming the id');
    return mailboxId;
  }
}

/** A message safe to hand the model for a failed mailbox lookup. Never carries a grant id. */
function mailboxFailureMessage(err: unknown): string {
  if (err instanceof UnknownMailboxError || err instanceof RemovedMailboxError || err instanceof MissingNylasApiKeyError) {
    return err.message;
  }
  return 'The principal mailbox is unavailable.';
}

function failMailbox(ctx: ToolContext, tool: string, err: unknown): { ok: false; error: string } {
  // Class and status only (B8, S4): a Nylas or vault error can carry the grant id.
  ctx.log.error({ ...grantSafeErrorFields(err), tool }, `${tool}: could not resolve the principal mailbox`);
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
    const found = await locate(ctx, kind, objectId, parsed.mailbox, tool);
    if (found.kind === 'found') return { ok: true, at: found.at };
    if (found.kind === 'not_found' && found.definitive && parsed.mailbox !== undefined) {
      // A miss in the one named mailbox is not "gone" (SF16): it may be in another account.
      const label = await mailboxLabel(ctx, parsed.mailbox);
      return { ok: false, error: `That ${kind} isn't in the ${label} mailbox; omit mailbox to search every account.`, errorType: 'NOT_FOUND' };
    }
    // A definite miss for a message everywhere keeps the "do not retry with this ID" wording the model acts on.
    if (kind === 'message' && found.kind === 'not_found' && found.definitive) {
      return { ok: false, error: messageNotFoundError(objectId), errorType: 'NOT_FOUND' };
    }
    const errorType = locateErrorType(found);
    return { ok: false, error: locateError(found, kind), ...(errorType ? { errorType } : {}) };
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
