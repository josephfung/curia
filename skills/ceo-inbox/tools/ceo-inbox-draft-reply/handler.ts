import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { locateInMailbox, mailboxFields, mailboxClient, readMailboxInput, type MailboxClient } from '../../../_shared/principal-mailbox-client.js';
import { type NylasParticipant, type DraftAttachment, type NylasMessageFull, type NylasDraftSummary, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';
import { buildReplyQuote } from '../../../../src/skills/_shared/reply-quote.js';
import { markdownToHtml } from '../../../../src/format/markdown-to-html.js';
import { parseAttachmentInputs } from '../../../_shared/parse-attachments.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES } from '../../../../src/skills/_shared/read-attachments.js';
import { captureDraftSnapshot } from '../../../_shared/voice-learning-capture.js';
import { isSpamOrTrash } from '../../../_shared/mail-folders.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import { firstMessageId } from '../../../_shared/triage-listing.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

// Same ceiling ceo-inbox-search uses when it scans drafts. A match stops the
// scan early. Hitting the ceiling without a match means we cannot prove the
// thread is draft-free, so we refuse to create rather than risk a duplicate.
const DRAFT_SCAN_LIMIT = 500;

// The whole redirect lookup (every read) gets this long, then counts as unreachable and falls
// back; the tool's own timeout is 30 s, so the rest is left for drafting.
const REDIRECT_TIMEOUT_MS = 8_000;

const EXCLUDED_COPY_FOLDERS = new Set(['SENT', 'DRAFT', 'DRAFTS', 'SPAM', 'TRASH']);
// A conservative subset of RFC 5322 atext plus '.', '@'. No space, quote, angle bracket, brace,
// '|', '*', '?', '~', '^' or backtick reaches the Gmail query: each can widen or group a search.
const SAFE_MESSAGE_ID = /^[A-Za-z0-9!#$%&+/=_.@-]+$/;

type Redirect =
  | { kind: 'same' }
  | { kind: 'moved'; at: MailboxClient; original: NylasMessageFull }
  | { kind: 'fallback'; reason: string };

/** `work`, or a rejection once the shared `deadline` (epoch ms) passes. */
function withTimeout<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A message's own RFC Message-ID (via the gateway client, headers included), and the message. */
async function ownId(ctx: ToolContext, clientAt: string, id: string): Promise<{ id?: string; msg: NylasMessage }> {
  const gateway = await ctx.principalMailboxes!.gatewayClient(clientAt);
  const msg = await gateway.getMessage(id, { includeHeaders: true, budget: ctx });
  const header = (msg.headers ?? []).find((h) => h.name.trim().toLowerCase() === 'message-id');
  return { ...(header ? { id: firstMessageId(header.value) } : {}), msg };
}

/** A message's sender set, lowercased and sorted, for comparing copies. */
const senders = (m: { from: NylasParticipant[] }): string => [...new Set(m.from.map((p) => p.email.toLowerCase()))].sort().join(',');

/**
 * Mail sent to both of the principal's mailboxes is answered from the one the sender addressed
 * first: the first live mailbox address in To, else in Cc. Finds that mailbox's copy by Message-ID.
 * Never throws; an unreachable or empty target is a fallback to the mailbox the message was given in.
 */
async function addressedCopy(ctx: ToolContext, at: MailboxClient, original: NylasMessageFull, messageId: string): Promise<Redirect> {
  // One deadline for the whole lookup, registry reads included: each read gets only what is left.
  const deadline = Date.now() + REDIRECT_TIMEOUT_MS;
  let live: Awaited<ReturnType<NonNullable<ToolContext['principalMailboxes']>['list']>>;
  let principalAddrs: string[];
  try {
    live = await withTimeout(ctx.principalMailboxes!.list(), deadline);
    if (live.length < 2) return { kind: 'same' };
    principalAddrs = await withTimeout(ctx.principalMailboxes!.principalEmailAddresses(), deadline);
  } catch (err) {
    // SF-M2: "never throws" holds for the registry reads too; the given mailbox still works.
    ctx.log.warn({ tool: 'ceo-inbox-draft-reply', ...grantSafeErrorFields(err) }, 'ceo-inbox-draft-reply: mailbox registry unreadable; drafting in the given mailbox');
    return { kind: 'fallback', reason: `the mailbox registry could not be read; drafted in the ${at.mailbox.label} mailbox` };
  }
  // Mail the principal sent from one account must never be redirected to the other (R58).
  const principal = new Set([...live.map((m) => m.address.toLowerCase()), ...principalAddrs]);
  if (original.from.some((p) => principal.has(p.email.toLowerCase()))) return { kind: 'same' };
  const byAddress = new Map(live.map((m) => [m.address.toLowerCase(), m]));
  const firstIn = (list: NylasParticipant[]) => list.map((p) => byAddress.get(p.email.toLowerCase())).find((m) => m !== undefined);
  const target = firstIn(original.to) ?? firstIn(original.cc);
  if (!target || target.id === at.mailbox.id) return { kind: 'same' };

  const fallback = (reason: string, err?: unknown): Redirect => {
    ctx.log.warn(
      { tool: 'ceo-inbox-draft-reply', from: at.mailbox.id, target: target.id, reason, ...(err !== undefined ? grantSafeErrorFields(err) : {}) },
      'ceo-inbox-draft-reply: addressed copy unavailable; drafting in the given mailbox',
    );
    return { kind: 'fallback', reason: `${reason}; drafted in the ${at.mailbox.label} mailbox instead of ${target.label}` };
  };
  try {
    const rfcId = (await withTimeout(ownId(ctx, at.mailbox.id, messageId), deadline)).id;
    if (!rfcId) return fallback('the message has no Message-ID to search by');
    // Nothing that could widen the search goes into the query.
    if (!SAFE_MESSAGE_ID.test(rfcId)) return fallback('the message has an unusual Message-ID that is not safe to search by');
    const other = await withTimeout(mailboxClient(ctx, target.id), deadline);
    let hits: Array<{ id: string; folders: string[] }>;
    let more: string | undefined;
    try {
      const page = await withTimeout(other.client.listMessagesPage({ query: `rfc822msgid:${rfcId}`, limit: 5 }), deadline);
      hits = page.messages;
      more = page.nextCursor;
    } catch (err) {
      return fallback(`the ${target.label} search failed or is unsupported`, err);
    }
    if (hits.length === 0) return fallback(`the ${target.label} copy was not found`);
    // Five hits with more behind them prove nothing about uniqueness: treat it as ambiguous.
    if (more) return fallback(`more than one matching copy in ${target.label}`);
    // A search hit is a lead, not proof (R57): only a copy with the same Message-ID and sender, outside
    // Sent, Drafts, Spam and Trash, counts, and it must be the only one.
    const verified: NylasMessageFull[] = [];
    for (const hit of hits) {
      if (hit.folders.some((f) => EXCLUDED_COPY_FOLDERS.has(f.toUpperCase()))) continue;
      const own = await withTimeout(ownId(ctx, target.id, hit.id), deadline);
      if (own.id !== rfcId) continue;
      const copy = await withTimeout(other.client.getMessage(hit.id), deadline);
      if (copy.from.length === 0 || senders(copy) !== senders(original)) continue;
      if (copy.folders.some((f) => EXCLUDED_COPY_FOLDERS.has(f.toUpperCase()))) continue;
      verified.push(copy);
    }
    if (verified.length === 0) return fallback(`the ${target.label} copy was not found`);
    if (verified.length > 1) return fallback(`more than one matching copy in ${target.label}`);
    return { kind: 'moved', at: other, original: verified[0]! };
  } catch (err) {
    return fallback(`the ${target.label} mailbox could not be reached`, err);
  }
}

/**
 * SF-M3 the other way round: the given mailbox is the one the sender addressed, but an earlier call
 * on another mailbox's copy may have fallen back and drafted there. One draft per message across
 * mailboxes, so that draft answers this call. Under the redirect deadline: null when no other
 * principal mailbox got a copy, none has a draft on its copy's thread, or the check fails (logged;
 * best-effort). 'incomplete' when a search or draft scan stopped short, so a draft may exist.
 */
async function earlierDraftOnOtherCopy(
  ctx: ToolContext,
  at: MailboxClient,
  original: NylasMessageFull,
  messageId: string,
): Promise<{ draft: NylasDraftSummary; mailbox: MailboxClient['mailbox'] } | 'incomplete' | null> {
  const deadline = Date.now() + REDIRECT_TIMEOUT_MS;
  try {
    const live = await withTimeout(ctx.principalMailboxes!.list(), deadline);
    if (live.length < 2) return null;
    // Mail the principal sent is never redirected (R58), so no fallback draft can exist for it.
    const principal = new Set([
      ...live.map((m) => m.address.toLowerCase()),
      ...(await withTimeout(ctx.principalMailboxes!.principalEmailAddresses(), deadline)).map((a) => a.toLowerCase()),
    ]);
    if (original.from.some((p) => principal.has(p.email.toLowerCase()))) return null;
    const recipients = new Set([...original.to, ...original.cc].map((p) => p.email.toLowerCase()));
    const others = live.filter((m) => m.id !== at.mailbox.id && recipients.has(m.address.toLowerCase()));
    if (others.length === 0) return null;
    const rfcId = (await withTimeout(ownId(ctx, at.mailbox.id, messageId), deadline)).id;
    if (!rfcId || !SAFE_MESSAGE_ID.test(rfcId)) return null;
    for (const m of others) {
      const other = await withTimeout(mailboxClient(ctx, m.id), deadline);
      const page: { messages: NylasMessageSummary[]; nextCursor?: string } =
        await withTimeout(other.client.listMessagesPage({ query: `rfc822msgid:${rfcId}`, limit: 5 }), deadline);
      // More hits than one page: the copy's thread may be among the unread ones.
      if (page.nextCursor) return 'incomplete';
      // A search hit is a lead, not proof (R57): only a copy with the same Message-ID and sender,
      // outside Sent, Drafts, Spam and Trash, names a thread whose draft answers this message.
      const threads = new Set<string>();
      for (const hit of page.messages) {
        if (hit.folders.some((f) => EXCLUDED_COPY_FOLDERS.has(f.toUpperCase()))) continue;
        const own: { id?: string } = await withTimeout(ownId(ctx, m.id, hit.id), deadline);
        if (own.id !== rfcId) continue;
        const copy: NylasMessageFull = await withTimeout(other.client.getMessage(hit.id), deadline);
        if (copy.from.length === 0 || senders(copy) !== senders(original)) continue;
        if (copy.folders.some((f) => EXCLUDED_COPY_FOLDERS.has(f.toUpperCase()))) continue;
        if (copy.threadId) threads.add(copy.threadId);
      }
      if (threads.size === 0) continue;
      const found = await withTimeout(other.client.listAllDrafts({ maxScan: DRAFT_SCAN_LIMIT, stopWhen: (d) => threads.has(d.threadId) }), deadline);
      const draft = found.drafts.find((d) => threads.has(d.threadId));
      if (draft) return { draft, mailbox: other.mailbox };
      // The scan stopped at its cap without a match: a draft may lie beyond it.
      if (found.truncated) return 'incomplete';
    }
  } catch (err) {
    // Best-effort: without the check this call drafts in the addressed mailbox as before.
    ctx.log.warn({ tool: 'ceo-inbox-draft-reply', ...grantSafeErrorFields(err) }, 'ceo-inbox-draft-reply: could not check the other mailboxes for an earlier draft');
  }
  return null;
}

export class CeoInboxDraftReplyHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const replyToMessageId =
      typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id.trim() : '';
    const body =
      typeof input.body === 'string' ? input.body.trim() : '';

    if (!replyToMessageId) {
      return { success: false, error: 'reply_to_message_id is required' };
    }
    const idError = validateNylasMessageId(replyToMessageId, 'reply_to_message_id');
    if (idError) {
      return { success: false, error: idError, errorType: 'VALIDATION_ERROR' };
    }

    if (!body) {
      return { success: false, error: 'body is required' };
    }

    const attachmentInputsParsed = parseAttachmentInputs(input.attachments);
    if (typeof attachmentInputsParsed === 'string') {
      return { success: false, error: attachmentInputsParsed };
    }

    let attachments: DraftAttachment[] = [];
    if (attachmentInputsParsed.length > 0) {
      try {
        attachments = await readAttachmentFiles(attachmentInputsParsed, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Attachment error: ${message}` };
      }
    }

    // Draft in the mailbox the message is in (#2475).
    const picked = await locateInMailbox(ctx, input, 'ceo-inbox-draft-reply', 'message', replyToMessageId);
    if (!picked.ok) {
      return { success: false, error: picked.error, ...(picked.errorType ? { errorType: picked.errorType } : {}) };
    }
    let client = picked.at.client;
    let mbx: Record<string, unknown> = mailboxFields(picked.at.mailbox);
    let selfEmail = picked.at.mailbox.address.toLowerCase();
    let replyId = replyToMessageId;

    // Guard: the mailbox address must be known — without it we cannot filter the principal's own
    // address from reply recipients, which would cause self-addressed drafts.
    if (!selfEmail) {
      ctx.log.error({ mailboxId: picked.at.mailbox.id }, 'ceo-inbox-draft-reply: mailbox address is empty — self-filter disabled');
      return { success: false, error: 'Configuration error: the principal mailbox address is not known' };
    }

    ctx.log.info(
      { replyToMessageId, bodyLength: body.length, attachmentCount: attachments.length },
      'ceo-inbox-draft-reply: preparing reply-all draft',
    );

    try {
      // Fetch the original message to compute reply-all recipients.
      // Reply-all: original sender → to, original to + cc (minus self) → cc.
      let original = await client.getMessage(replyToMessageId);

      // Guard: without a sender we have no valid To address — fail rather than
      // silently creating a draft addressed to the placeholder 'unknown'.
      if (original.from.length === 0) {
        ctx.log.error(
          { replyToMessageId },
          'ceo-inbox-draft-reply: original message has no sender address; cannot create reply draft',
        );
        return { success: false, error: 'Original message has no sender address; cannot create a reply draft' };
      }

      // Mail sent to both mailboxes is answered from the copy the sender addressed first. A
      // mailbox the principal named is never overridden (#2475).
      // The given copy's own folder is checked before any redirect: a Spam or Trash copy is refused
      // even when another mailbox holds a clean copy (the redirected copy is checked again below).
      if (isSpamOrTrash(original.folders)) {
        ctx.log.warn(
          { replyToMessageId, folders: original.folders },
          'ceo-inbox-draft-reply: refusing to draft a reply to a message in Spam or Trash',
        );
        return { success: false, error: 'Message is in Spam or Trash; not drafting a reply' };
      }

      let givenScanIncomplete = false;
      const explicit = readMailboxInput(input);
      if (explicit.ok && explicit.mailbox === undefined) {
        const redirect = await addressedCopy(ctx, picked.at, original, replyToMessageId);
        if (redirect.kind === 'same') {
          const elsewhere = await earlierDraftOnOtherCopy(ctx, picked.at, original, replyToMessageId);
          if (elsewhere === 'incomplete') {
            // Same rule as the drafted mailbox's own scan: unable to rule out a draft, so none is made.
            ctx.log.warn({ mailboxId: picked.at.mailbox.id }, 'ceo-inbox-draft-reply: other-mailbox draft check incomplete — refusing to create a draft');
            return { success: false, error: 'Unable to determine whether this message already has a draft in another mailbox; scan incomplete' };
          }
          if (elsewhere) {
            ctx.log.info({ draftId: elsewhere.draft.id, mailboxId: elsewhere.mailbox.id }, 'ceo-inbox-draft-reply: another mailbox already has a draft for this message');
            const d = elsewhere.draft;
            return {
              success: true,
              data: {
                draft_id: d.id, subject: d.subject, to: d.to, cc: d.cc,
                snippet: d.snippet, date: d.date, already_exists: true, ...mailboxFields(elsewhere.mailbox),
              },
            };
          }
        }
        if (redirect.kind === 'moved' && original.threadId) {
          // SF-M3: an earlier call may have fallen back and drafted in the given mailbox; one
          // draft per message across both, so that draft answers this call too.
          const givenThread = original.threadId;
          const given = await picked.at.client.listAllDrafts({ maxScan: DRAFT_SCAN_LIMIT, stopWhen: (d) => d.threadId === givenThread });
          const earlier = given.drafts.find((d) => d.threadId === givenThread);
          if (!earlier && given.truncated) {
            // The scan stopped at its cap without finding a draft: one may lie beyond it. A draft
            // already in the addressed mailbox still answers this call (checked below); only
            // creating a new one is refused, as for the drafted mailbox's own incomplete scan.
            givenScanIncomplete = true;
          }
          if (earlier) {
            ctx.log.info({ draftId: earlier.id, mailboxId: picked.at.mailbox.id }, 'ceo-inbox-draft-reply: the given mailbox already has a draft for this thread');
            return {
              success: true,
              data: {
                draft_id: earlier.id, subject: earlier.subject, to: earlier.to, cc: earlier.cc,
                snippet: earlier.snippet, date: earlier.date, already_exists: true, ...mbx,
              },
            };
          }
        }
        if (redirect.kind === 'moved') {
          client = redirect.at.client;
          mbx = mailboxFields(redirect.at.mailbox);
          selfEmail = redirect.at.mailbox.address.toLowerCase();
          original = redirect.original;
          replyId = redirect.original.id;
        } else if (redirect.kind === 'fallback') {
          mbx = { ...mbx, reply_mailbox_fallback: true, reply_mailbox_note: redirect.reason };
        }
      }

      // Spam and Trash are not triage. Search omits them by default; this
      // refuses a draft when an id arrives another way (a SPAM folder list,
      // an explicit opt-in, task notes, or a retry) (#2035).
      if (isSpamOrTrash(original.folders)) {
        ctx.log.warn(
          { replyToMessageId, folders: original.folders },
          'ceo-inbox-draft-reply: refusing to draft a reply to a message in Spam or Trash',
        );
        return { success: false, error: 'Message is in Spam or Trash; not drafting a reply' };
      }

      // One draft per thread. A later run, a retry, or the model repeating the
      // same call must not create another (#2035). Draft summaries carry
      // threadId but not the message they reply to. The returned snippet and
      // date let the caller see whether that draft is the one it meant to send.
      if (original.threadId) {
        const { drafts, truncated } = await client.listAllDrafts({
          maxScan: DRAFT_SCAN_LIMIT,
          stopWhen: (draft) => draft.threadId === original.threadId,
        });
        const existing = drafts.find((draft) => draft.threadId === original.threadId);
        if (existing) {
          ctx.log.info(
            { draftId: existing.id, threadId: original.threadId, replyToMessageId },
            'ceo-inbox-draft-reply: thread already has a draft',
          );
          return {
            success: true,
            data: {
              draft_id: existing.id,
              subject: existing.subject,
              to: existing.to,
              cc: existing.cc,
              snippet: existing.snippet,
              date: existing.date,
              already_exists: true,
              ...mbx,
            },
          };
        }
        if (truncated || givenScanIncomplete) {
          ctx.log.warn(
            { threadId: original.threadId, cap: DRAFT_SCAN_LIMIT, givenScanIncomplete },
            'ceo-inbox-draft-reply: draft scan hit the cap without finding this thread — refusing to create a draft',
          );
          return {
            success: false,
            error: 'Unable to determine whether this thread already has a draft; draft scan incomplete',
          };
        }
      } else if (givenScanIncomplete) {
        // No thread to check here, so nothing can answer the call: the incomplete scan still refuses.
        return { success: false, error: 'Unable to determine whether this thread already has a draft; draft scan incomplete' };
      }

      // To: the original sender
      const to: NylasParticipant[] = original.from;

      // CC: everyone from original to + cc, minus the principal's own address
      // and minus the original sender (already in "to")
      // Every principal address is excluded, not just this mailbox's: a message to both of the
      // principal's mailboxes must not CC the other one (#2475).
      const principalAddresses = new Set([selfEmail, ...(await ctx.principalMailboxes!.principalEmailAddresses())]);
      const senderEmails = new Set(original.from.map((p) => p.email.toLowerCase()));
      const ccCandidates = [...original.to, ...original.cc].filter((p) => {
        const lower = p.email.toLowerCase();
        return !principalAddresses.has(lower) && !senderEmails.has(lower);
      });

      // Deduplicate cc by email (case-insensitive)
      const seenCc = new Set<string>();
      const cc = ccCandidates.filter((p) => {
        const lower = p.email.toLowerCase();
        if (seenCc.has(lower)) return false;
        seenCc.add(lower);
        return true;
      });

      // Nylas v3 does not auto-populate the subject from reply_to_message_id —
      // we must set it explicitly or the draft lands with a blank subject.
      // Strip existing Re: prefix (case-insensitive) before prepending our own to
      // avoid "Re: RE: Re: ..." chains — matches the pattern used by email-reply
      // and email-adapter.
      const replySubject = `Re: ${original.subject.replace(/^Re:\s*/i, '')}`;

      ctx.log.info(
        { replyToMessageId, toCount: to.length, ccCount: cc.length, replySubject },
        'ceo-inbox-draft-reply: computed reply-all recipients',
      );

      // Convert the LLM-authored body to sanitized HTML before combining with
      // the quote; direct HTML bodies are detected inside markdownToHtml().
      const htmlBody = markdownToHtml(body, { wrap: true });
      let draftBody = htmlBody;
      try {
        const htmlQuote = buildReplyQuote(original, ctx.timezone, { format: 'html' });
        // Apply the same size guard used by the other reply callers — a long quoted
        // thread should not produce an oversized Nylas draft payload.
        if (htmlBody.length + htmlQuote.length <= 50_000) {
          draftBody = htmlBody + htmlQuote;
        }
      } catch (err) {
        ctx.log.warn(
          { ...grantSafeErrorFields(err), replyToMessageId },
          'ceo-inbox-draft-reply: failed to build reply quote — proceeding without quote',
        );
      }

      const draft = await client.createDraftReply({
        replyToMessageId: replyId,
        subject: replySubject,
        body: draftBody,
        to,
        cc,
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      ctx.log.info(
        { draftId: draft.id, subject: draft.subject },
        'ceo-inbox-draft-reply: draft created',
      );

      // Best-effort voice-learning snapshot — fire-and-forget so it never adds latency to
      // draft creation (#1421). captureDraftSnapshot logs its own failures and never
      // rejects; the .catch guards against an unexpected throw becoming an unhandled
      // rejection.
      void captureDraftSnapshot(ctx, {
        draftId: draft.id,
        threadId: draft.threadId || original.threadId,
        subject: draft.subject,
        to: draft.to,
        cc: draft.cc,
        body,
        // The mailbox the draft was created in: after a redirect that is the addressed copy's.
        ...(typeof mbx.mailbox === 'string' ? { mailbox: mbx.mailbox } : {}),
      }).catch((err) =>
        ctx.log.error(grantSafeErrorFields(err), 'ceo-inbox-draft-reply: voice snapshot capture rejected'),
      );

      return {
        success: true,
        data: {
          draft_id: draft.id,
          subject: draft.subject,
          to: draft.to,
          cc: draft.cc,
          already_exists: false,
          // The message this draft answers (#2474 final fixes A5): an autonomous send reads it
          // from this result's audit row and requires it to be the thread's latest message.
          reply_to_message_id: replyId,
          ...mbx,
        },
      };
    } catch (err) {
      ctx.log.error(
        { ...grantSafeErrorFields(err), replyToMessageId },
        'ceo-inbox-draft-reply: failed to create draft',
      );
      return { success: false, ...nylasMessageFailure(err, replyToMessageId, 'Failed to create draft reply in principal inbox') };
    }
  }
}
