// Triage mode of ceo-inbox-list (#2475, D4). Code decides everything about the batch: which
// mailboxes are due (dueMailboxes, R7), round-robin across them, the start line, the cross-mailbox
// dedupe, a one-time backlog alarm and the daily ceiling. The model cannot drain past the limits.
//
// Accounting rules:
//   - The ceiling gates before any work. addBatch runs once per call that RETURNS messages; an
//     empty batch is not counted (it cost no triage work, and counting idle polls would let them
//     eat the day's budget).
//   - R52: markDrained stamps the START of the drain episode (kept in TriageState), so a long
//     drain does not delay the next one by its own length.
//   - R70: with two or more live mailboxes, EVERY batched message is claimed (one header read
//     each), so an auto-forwarded or Bcc'd copy that names no other mailbox is still triaged
//     once. With one mailbox nothing is claimed. Failing to dedupe fails toward triaging twice.
import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { grantSafeErrorFields } from '../../src/principal-mailboxes/error-fields.js';
import { dueMailboxes } from '../../src/principal-mailboxes/triage-due.js';
import { BACKLOG_ALARM_THRESHOLD, TRIAGE_BATCH_SIZE } from '../../src/principal-mailboxes/triage-cadence.js';
import type { CeoNylasClient, NylasMessageSummary } from './ceo-nylas-client.js';
import { NYLAS_MAX_LIST_LIMIT } from './ceo-nylas-client.js';
import { describeError, scanMailbox, type MailboxError, type Target } from './cross-mailbox-listing.js';
import { mailboxFields } from './principal-mailbox-client.js';
import { isTriageCandidate } from '../../src/principal-mailboxes/triage-candidate.js';

const PAGE_CAP = 25;
/** Messages queued per mailbox: a batch, a probe for has_more, and room for dropped duplicates. */
const QUEUE_NEED = TRIAGE_BATCH_SIZE * 2 + 1;
const TOOL = 'ceo-inbox-list';
const NOTE = 'Its mail is not included; a later call retries it.';
const lc = (s: string): string => s.toLowerCase();

/**
 * The first bracketed `<left@right>` id in a Message-ID header (P5). A bare token is not used: a
 * sender that stamps the same junk value on every message would otherwise make distinct messages
 * collide. Brackets are kept off; TriageDedupe normalises case.
 */
export function firstMessageId(value: string): string | undefined {
  return /<([^<>\s@]+@[^<>\s@]+)>/.exec(value)?.[1];
}

interface Scanned {
  target: Target;
  queue: NylasMessageSummary[];
  more: boolean;
  scannedAny: boolean;
  exhausted: boolean;
  /** The page cap stopped the scan. With nothing kept, nothing is known about the mailbox. */
  capped: boolean;
}

/** Label folder id by mailbox and label, looked up (or created) once per call. */
type FolderLookups = Map<string, Promise<{ id: string }>>;

/** Add `label` to the message in this mailbox, creating the label here if it is new. */
async function labelMessage(client: CeoNylasClient, mailboxId: string, messageId: string, label: string, lookups: FolderLookups): Promise<void> {
  const key = `${mailboxId}\u0000${label.toUpperCase()}`;
  let pending = lookups.get(key);
  if (!pending) {
    pending = (async () => {
      const folders = await client.listFolders();
      return folders.find((f) => f.name.toUpperCase() === label.toUpperCase()) ?? (await client.createFolder(label));
    })();
    lookups.set(key, pending);
    // A failed lookup must be retried by a later message, not cached.
    pending.catch(() => lookups.delete(key));
  }
  const folder = await pending;
  const current = await client.getMessage(messageId);
  await client.updateMessageFolders(messageId, [...new Set([...(current.folders ?? []), folder.id])]);
}

/** The principal's verified email addresses, lowercased; [] (logged) when they cannot be read. */
async function otherPrincipalAddresses(ctx: ToolContext): Promise<string[]> {
  if (!ctx.principalMailboxes) return [];
  try {
    return (await ctx.principalMailboxes.principalEmailAddresses()).map(lc);
  } catch (err) {
    ctx.log.warn({ tool: TOOL, ...grantSafeErrorFields(err) }, 'ceo-inbox-list: principal addresses could not be read; only mailbox addresses flag mail from the principal');
    return [];
  }
}

/**
 * True when another mailbox already triaged this message (the copy here was dropped: marked read
 * and labelled). Every failure returns false: fail toward triaging twice, never toward dropping.
 */
async function lostClaim(
  ctx: ToolContext,
  svc: NonNullable<ToolContext['triageServices']>,
  target: Target,
  msg: NylasMessageSummary,
  allMailboxes: PrincipalMailboxView[],
  lookups: FolderLookups,
): Promise<boolean> {
  const { mailbox, client } = target;
  const fail = (err: unknown, what: string): false => {
    // Grant-safe: SDK errors can carry the grant id.
    ctx.log.warn({ tool: TOOL, mailboxId: mailbox.id, ...grantSafeErrorFields(err) }, `ceo-inbox-list: ${what}; the message stays in the batch`);
    return false;
  };
  let claim: Awaited<ReturnType<typeof svc.dedupe.claim>>;
  try {
    const gateway = await ctx.principalMailboxes!.gatewayClient(mailbox.id);
    const full = await gateway.getMessage(msg.id, { includeHeaders: true, budget: ctx });
    const header = (full.headers ?? []).find((h) => h.name.trim().toLowerCase() === 'message-id');
    const messageId = header ? firstMessageId(header.value) : undefined;
    if (!messageId) {
      ctx.log.warn({ tool: TOOL, mailboxId: mailbox.id }, 'ceo-inbox-list: a cross-mailbox message has no Message-ID; not deduped');
      return false;
    }
    // Keyed on Message-ID AND From (R54): a reused Message-ID from another sender is no duplicate.
    const from = msg.from[0]?.email;
    if (!from) {
      ctx.log.warn({ tool: TOOL, mailboxId: mailbox.id }, 'ceo-inbox-list: a message has no From address; not deduped');
      return false;
    }
    claim = await svc.dedupe.claim(messageId, from, mailbox.id, msg.id);
  } catch (err) {
    return fail(err, 'dedupe check failed');
  }
  // First seen wins; the winner being this very mailbox is a re-sight, not a duplicate.
  if (claim.first || claim.mailboxId === mailbox.id) return false;
  // A winner that is no longer live (removed before its copy was triaged) holds no claim: this
  // copy is triaged rather than dropped unseen (SEC-L3, SF-M5).
  const winnerView = allMailboxes.find((m) => m.id === claim.mailboxId);
  if (!winnerView) {
    ctx.log.info({ tool: TOOL, mailboxId: mailbox.id, winner: claim.mailboxId }, 'ceo-inbox-list: the copy\'s claim belongs to a mailbox no longer live; triaging this copy');
    return false;
  }
  const winner = winnerView.label;
  if (!client) return false;
  // A copy that cannot be marked read would be dropped on every call and never leave the unread
  // set, starving older mail. Keep it: triaging it twice is the safe failure (fix round 1).
  try {
    await client.markAsRead(msg.id);
  } catch (err) {
    return fail(err, 'could not mark the second copy read');
  }
  try {
    await labelMessage(client, mailbox.id, msg.id, `↔ In ${winner}`, lookups);
  } catch (err) {
    // Read already, so it leaves the unread set: dropped, just without its label.
    ctx.log.warn({ tool: TOOL, mailboxId: mailbox.id, ...grantSafeErrorFields(err) }, 'ceo-inbox-list: the second copy is read but could not be labelled; it is dropped from the batch');
  }
  return true;
}

export async function triageList(ctx: ToolContext, targets: Target[], curiaEmails: ReadonlySet<string>): Promise<ToolResult> {
  const svc = ctx.triageServices;
  if (!svc) return { success: false, error: 'Triage is unavailable: triage services are not configured.' };
  const log = ctx.log;
  const now = new Date();
  const batchMax = TRIAGE_BATCH_SIZE;

  try {
    if (await svc.state.ceilingReached(now)) {
      log.info({ tool: TOOL }, 'ceo-inbox-list: daily triage ceiling reached; returning an empty batch');
      return { success: true, data: { messages: [], count: 0, has_more: false, mailboxes_due: [], budget_exhausted: true } };
    }

    const ids = targets.map((t) => t.mailbox.id);
    const due = await dueMailboxes({
      mailboxIds: ids, cadences: await svc.cadences(ids), state: svc.state, now, tz: svc.tz(),
    });
    const dueTargets = targets.filter((t) => due.includes(t.mailbox.id));
    const allMailboxes: PrincipalMailboxView[] = ctx.principalMailboxes ? await ctx.principalMailboxes.list() : targets.map((t) => t.mailbox);
    const addressOf = new Map(allMailboxes.map((m) => [m.id, lc(m.address)]));
    const claimAll = allMailboxes.length >= 2;
    const principalAddrs = new Set([...allMailboxes.map((m) => lc(m.address)), ...(await otherPrincipalAddresses(ctx))].filter((a) => a !== ''));

    const lookups: FolderLookups = new Map();
    const errors: MailboxError[] = [];
    const backlog: Array<{ mailbox: string; mailbox_label: string; untriaged_over: number }> = [];
    const scans: Scanned[] = [];
    await Promise.all(dueTargets.map(async (target) => {
      const { mailbox, client } = target;
      if (!client) {
        errors.push({ mailbox: mailbox.id, mailbox_label: mailbox.label, error: target.failure ?? 'unavailable', note: NOTE });
        return;
      }
      const startSec = mailbox.triageStartAt ? Math.floor(mailbox.triageStartAt.getTime() / 1000) : undefined;
      let dropped = 0;
      const filters = { folder: 'INBOX', unread: true as const, ...(startSec !== undefined ? { receivedAfter: startSec } : {}) };
      try {
        const scan = await scanMailbox<NylasMessageSummary>({
          start: { cursor: null, skip: 0 },
          need: QUEUE_NEED,
          pageCap: PAGE_CAP,
          fetchPage: (cursor) => client.listMessagesPage({
            ...filters, limit: cursor ? NYLAS_MAX_LIST_LIMIT : QUEUE_NEED, ...(cursor ? { pageToken: cursor } : {}),
          }),
          // The shared keep rule (BR-I3): the heartbeat probe uses it too, so they agree.
          keep: (m) => {
            const kept = isTriageCandidate(m, curiaEmails, startSec);
            if (!kept) dropped += 1;
            return kept;
          },
        });
        if (dropped > 0) log.info({ tool: TOOL, mailboxId: mailbox.id, dropped }, 'ceo-inbox-list: triage skipped read, non-INBOX, pre-start-line or Curia mail');
        const queue = scan.items.map((i) => i.item);
        scans.push({ target, queue, scannedAny: queue.length > 0, exhausted: scan.end === null, capped: scan.capped, more: false });
        // Untriaged count past the start line, bounded: only when the first scan shows more than a
        // queue's worth, and only until the alarm has fired this episode.
        if (scan.end !== null && queue.length >= QUEUE_NEED && !(await svc.state.backlogAlarmed(mailbox.id))) {
          try {
            // Counted with the same keep rule, so Curia's own unread mail cannot raise it (BR-M10),
            // and scanned until enough real mail is seen, so filtered (possibly spoofed) mail
            // cannot use up the count's window either (R71). Bounded by the page cap.
            const counted = await scanMailbox<NylasMessageSummary>({
              start: { cursor: null, skip: 0 },
              need: BACKLOG_ALARM_THRESHOLD + 1,
              pageCap: PAGE_CAP,
              fetchPage: (cursor) => client.listMessagesPage({ ...filters, limit: NYLAS_MAX_LIST_LIMIT, ...(cursor ? { pageToken: cursor } : {}) }),
              keep: (m) => isTriageCandidate(m, curiaEmails, startSec),
            });
            if (counted.items.length > BACKLOG_ALARM_THRESHOLD) backlog.push({ mailbox: mailbox.id, mailbox_label: mailbox.label, untriaged_over: BACKLOG_ALARM_THRESHOLD });
          } catch (err) {
            log.warn({ tool: TOOL, mailboxId: mailbox.id, ...grantSafeErrorFields(err) }, 'ceo-inbox-list: backlog count failed; no alarm this call');
          }
        }
      } catch (err) {
        log.warn({ tool: TOOL, mailboxId: mailbox.id, ...grantSafeErrorFields(err) }, 'ceo-inbox-list: a mailbox could not be read for triage');
        errors.push({ mailbox: mailbox.id, mailbox_label: mailbox.label, error: describeError(err), note: NOTE });
      }
    }));
    scans.sort((a, b) => ids.indexOf(a.target.mailbox.id) - ids.indexOf(b.target.mailbox.id));

    // No-progress count (R67): a due mailbox that could not be read counts one, before an
    // all-failed call returns. The heartbeat backs a mailbox that keeps failing off.
    for (const e of errors) await svc.state.setNoProgress(e.mailbox, (await svc.state.noProgress(e.mailbox)) + 1);

    if (dueTargets.length > 0 && scans.length === 0) {
      return { success: false, error: `Failed to list principal inbox messages for triage (${errors.map((e) => `${e.mailbox_label}: ${e.error}`).join('; ')})` };
    }

    // One message at a time across the due mailboxes, so a busy inbox cannot starve the other.
    const batch: Array<Record<string, unknown>> = [];
    let progressed = true;
    while (batch.length < batchMax && progressed) {
      progressed = false;
      for (const s of scans) {
        if (batch.length >= batchMax) break;
        const msg = s.queue.shift();
        if (!msg) continue;
        progressed = true;
        const { mailbox } = s.target;
        // BR-M5: mail from any OTHER principal address (another live mailbox, or a verified address
        // with no mailbox) is flagged. The flag rests on the unauthenticated From header, so it
        // only ever restricts handling (SEC-L4), never grants principal authority.
        const ownAddr = addressOf.get(mailbox.id);
        const fromOther = msg.from.some((p) => lc(p.email) !== ownAddr && principalAddrs.has(lc(p.email)));
        if (claimAll) {
          const lost = await lostClaim(ctx, svc, s.target, msg, allMailboxes, lookups);
          if (lost) continue;
        }
        batch.push({ ...msg, ...mailboxFields(mailbox), ...(fromOther ? { from_principal_other_mailbox: true } : {}) });
      }
    }

    for (const s of scans) {
      s.more = s.queue.length > 0 || (!s.exhausted && s.scannedAny);
    }

    // No-progress count (R67), continued: a capped scan that kept nothing counts one; any other
    // outcome resets it.
    for (const s of scans) {
      const id = s.target.mailbox.id;
      if (s.capped && !s.scannedAny) await svc.state.setNoProgress(id, (await svc.state.noProgress(id)) + 1);
      else if ((await svc.state.noProgress(id)) > 0) await svc.state.setNoProgress(id, 0);
    }

    // Drain bookkeeping (R52).
    let scanIncomplete = false;
    for (const s of scans) {
      const id = s.target.mailbox.id;
      // The cap stopped a scan that kept nothing: say nothing is known, and leave the drain state.
      if (s.capped && !s.scannedAny) {
        scanIncomplete = true;
        log.error({ tool: TOOL, mailboxId: id, pages: PAGE_CAP }, 'ceo-inbox-list: paging cap reached with nothing to triage; mailbox left as it was');
        continue;
      }
      // R68: a mailbox whose last messages are in THIS batch stays draining (settle pending) until
      // the heartbeat sees the run finished, so a failed run's retry still finds it due and gets
      // the same unread messages back. Only a call that finds nothing closes the episode here.
      const listedHere = batch.some((m) => m['mailbox'] === id);
      if (s.more || listedHere) {
        if (!(await svc.state.isDraining(id))) await svc.state.setDrainStartedAt(id, now);
        await svc.state.setDraining(id, true);
        if (s.more) {
          if (await svc.state.settlePending(id)) await svc.state.setSettlePending(id, false);
        } else {
          await svc.state.setSettlePending(id, true);
        }
      } else {
        await svc.state.closeEpisode(id, now);
      }
    }
    for (const b of backlog) await svc.state.setBacklogAlarmed(b.mailbox, true);

    if (batch.length > 0) await svc.state.addBatch(now);

    const hasMore = scans.some((s) => s.more);
    return {
      success: true,
      data: {
        messages: batch,
        count: batch.length,
        has_more: hasMore,
        mailboxes_due: due,
        ...(backlog.length > 0 ? { backlog } : {}),
        ...(scanIncomplete ? { scan_incomplete: true } : {}),
        ...(errors.length > 0 ? { mailbox_errors: errors } : {}),
      },
    };
  } catch (err) {
    log.error({ tool: TOOL, ...grantSafeErrorFields(err) }, 'ceo-inbox-list: triage failed');
    return { success: false, error: 'Failed to list principal inbox messages for triage' };
  }
}
