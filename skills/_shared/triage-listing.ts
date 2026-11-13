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
//   - A message is deduped only when its from/to/cc names ANOTHER live mailbox's address; only
//     those pay for a getMessage with headers. Failing to dedupe fails toward triaging twice.
import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { grantSafeErrorFields } from '../../src/principal-mailboxes/error-fields.js';
import { dueMailboxes } from '../../src/principal-mailboxes/triage-due.js';
import { BACKLOG_ALARM_THRESHOLD, TRIAGE_BATCH_SIZE } from '../../src/principal-mailboxes/triage-cadence.js';
import { messageIdsIn } from '../../src/skills/principal-send/autonomous-limits.js';
import type { CeoNylasClient, NylasMessageSummary } from './ceo-nylas-client.js';
import { NYLAS_MAX_LIST_LIMIT } from './ceo-nylas-client.js';
import { describeError, scanMailbox, type MailboxError, type Target } from './cross-mailbox-listing.js';
import { mailboxFields } from './principal-mailbox-client.js';

const PAGE_CAP = 25;
/** Messages queued per mailbox: a batch, a probe for has_more, and room for dropped duplicates. */
const QUEUE_NEED = TRIAGE_BATCH_SIZE * 2 + 1;
const TOOL = 'ceo-inbox-list';
const NOTE = 'Its mail is not included; a later call retries it.';
const lc = (s: string): string => s.toLowerCase();

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
    const messageId = header ? messageIdsIn(header.value)[0] : undefined;
    if (!messageId) {
      ctx.log.warn({ tool: TOOL, mailboxId: mailbox.id }, 'ceo-inbox-list: a cross-mailbox message has no Message-ID; not deduped');
      return false;
    }
    // Keyed on Message-ID AND From (R54): a reused Message-ID from another sender is no duplicate.
    const from = msg.from[0]?.email;
    if (!from) return false;
    claim = await svc.dedupe.claim(messageId, from, mailbox.id, msg.id);
  } catch (err) {
    return fail(err, 'dedupe check failed');
  }
  // First seen wins; the winner being this very mailbox is a re-sight, not a duplicate.
  if (claim.first || claim.mailboxId === mailbox.id) return false;
  const winner = allMailboxes.find((m) => m.id === claim.mailboxId)?.label ?? claim.mailboxId;
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
      const filters = { folder: 'INBOX', unread: true as const, ...(startSec !== undefined ? { receivedAfter: startSec } : {}) };
      try {
        const scan = await scanMailbox<NylasMessageSummary>({
          start: { cursor: null, skip: 0 },
          need: QUEUE_NEED,
          pageCap: PAGE_CAP,
          fetchPage: (cursor) => client.listMessagesPage({
            ...filters, limit: cursor ? NYLAS_MAX_LIST_LIMIT : QUEUE_NEED, ...(cursor ? { pageToken: cursor } : {}),
          }),
          // The start line is also enforced here: a provider that ignores received_after must not
          // let older mail in. Dates are Unix seconds.
          keep: (m) => m.unread
            && m.folders.some((f) => f.toUpperCase() === 'INBOX')
            && !m.from.some((p) => curiaEmails.has(lc(p.email)))
            && (startSec === undefined || m.date >= startSec),
        });
        const queue = scan.items.map((i) => i.item);
        scans.push({ target, queue, scannedAny: queue.length > 0, exhausted: scan.end === null, capped: scan.capped, more: false });
        // Untriaged count past the start line, bounded: only when the first scan shows more than a
        // queue's worth, and only until the alarm has fired this episode.
        if (scan.end !== null && queue.length >= QUEUE_NEED && !(await svc.state.backlogAlarmed(mailbox.id))) {
          try {
            const counted = await client.listAllMessages({ ...filters, limit: NYLAS_MAX_LIST_LIMIT, maxScan: BACKLOG_ALARM_THRESHOLD + 1 });
            if (counted.messages.length > BACKLOG_ALARM_THRESHOLD) backlog.push({ mailbox: mailbox.id, mailbox_label: mailbox.label, untriaged_over: BACKLOG_ALARM_THRESHOLD });
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
        const others = allMailboxes.filter((m) => m.id !== mailbox.id && addressOf.get(m.id));
        const otherAddrs = new Set(others.map((m) => addressOf.get(m.id)!));
        const fromOther = msg.from.some((p) => otherAddrs.has(lc(p.email)));
        const namesOther = fromOther || [...msg.to, ...msg.cc].some((p) => otherAddrs.has(lc(p.email)));
        if (namesOther) {
          const lost = await lostClaim(ctx, svc, s.target, msg, allMailboxes, lookups);
          if (lost) continue;
        }
        batch.push({ ...msg, ...mailboxFields(mailbox), ...(fromOther ? { from_principal_other_mailbox: true } : {}) });
      }
    }

    for (const s of scans) {
      s.more = s.queue.length > 0 || (!s.exhausted && s.scannedAny);
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
      if (s.more) {
        if (!(await svc.state.isDraining(id))) await svc.state.setDrainStartedAt(id, now);
        await svc.state.setDraining(id, true);
      } else {
        const wasDraining = await svc.state.isDraining(id);
        const startedAt = (wasDraining ? await svc.state.drainStartedAt(id) : null) ?? now;
        await svc.state.markDrained(id, startedAt);
        await svc.state.setDraining(id, false);
        await svc.state.setDrainStartedAt(id, null);
        if (await svc.state.backlogAlarmed(id)) await svc.state.setBacklogAlarmed(id, false);
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
