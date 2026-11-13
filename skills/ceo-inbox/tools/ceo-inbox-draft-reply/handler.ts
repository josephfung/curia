import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { locateInMailbox, mailboxFields, mailboxClient, readMailboxInput, type MailboxClient } from '../../../_shared/principal-mailbox-client.js';
import { type NylasParticipant, type DraftAttachment, type NylasMessageFull } from '../../../_shared/ceo-nylas-client.js';
import { nylasMessageFailure, validateNylasMessageId } from '../../../../src/channels/email/nylas-message-id.js';
import { buildReplyQuote } from '../../../../src/skills/_shared/reply-quote.js';
import { markdownToHtml } from '../../../../src/format/markdown-to-html.js';
import { parseAttachmentInputs } from '../../../_shared/parse-attachments.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES } from '../../../../src/skills/_shared/read-attachments.js';
import { captureDraftSnapshot } from '../../../_shared/voice-learning-capture.js';
import { isSpamOrTrash } from '../../../_shared/mail-folders.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import { messageIdsIn } from '../../../../src/skills/principal-send/autonomous-limits.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

// Same ceiling ceo-inbox-search uses when it scans drafts. A match stops the
// scan early. Hitting the ceiling without a match means we cannot prove the
// thread is draft-free, so we refuse to create rather than risk a duplicate.
const DRAFT_SCAN_LIMIT = 500;

// A redirect lookup that takes longer than this counts as unreachable; the tool's own timeout is 30 s.
const REDIRECT_TIMEOUT_MS = 8_000;

const EXCLUDED_COPY_FOLDERS = new Set(['SENT', 'DRAFT', 'DRAFTS', 'SPAM', 'TRASH']);
// RFC 5322 atext plus '.', '@': no space, quote or angle bracket reaches the Gmail query.
const SAFE_MESSAGE_ID = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]+$/;

type Redirect =
  | { kind: 'same' }
  | { kind: 'moved'; at: MailboxClient; original: NylasMessageFull }
  | { kind: 'fallback'; reason: string };

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), REDIRECT_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mail sent to both of the principal's mailboxes is answered from the one the sender addressed
 * first: the first live mailbox address in To, else in Cc. Finds that mailbox's copy by Message-ID.
 * Never throws; an unreachable or empty target is a fallback to the mailbox the message was given in.
 */
async function addressedCopy(ctx: ToolContext, at: MailboxClient, original: NylasMessageFull, messageId: string): Promise<Redirect> {
  const live = await ctx.principalMailboxes!.list();
  if (live.length < 2) return { kind: 'same' };
  // Mail the principal sent from one account must never be redirected to the other (R58).
  const principal = new Set([...live.map((m) => m.address.toLowerCase()), ...(await ctx.principalMailboxes!.principalEmailAddresses())]);
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
  const ownId = async (clientAt: string, id: string): Promise<{ id?: string; msg: NylasMessage }> => {
    const gateway = await ctx.principalMailboxes!.gatewayClient(clientAt);
    const msg = await gateway.getMessage(id, { includeHeaders: true, budget: ctx });
    const header = (msg.headers ?? []).find((h) => h.name.trim().toLowerCase() === 'message-id');
    return { ...(header ? { id: messageIdsIn(header.value)[0] } : {}), msg };
  };
  const senders = (m: { from: NylasParticipant[] }) => m.from.map((p) => p.email.toLowerCase()).sort().join(',');
  try {
    const rfcId = (await ownId(at.mailbox.id, messageId)).id;
    if (!rfcId) return fallback('the message has no Message-ID to search by');
    // Nothing that could widen the search goes into the query.
    if (!SAFE_MESSAGE_ID.test(rfcId)) return fallback('the message has an unusual Message-ID that is not safe to search by');
    const other = await withTimeout(mailboxClient(ctx, target.id));
    let hits: Array<{ id: string; folders: string[] }>;
    try {
      hits = (await withTimeout(other.client.listMessagesPage({ query: `rfc822msgid:${rfcId}`, limit: 5 }))).messages;
    } catch (err) {
      return fallback(`the ${target.label} search failed or is unsupported`, err);
    }
    if (hits.length === 0) return fallback(`the ${target.label} copy was not found`);
    // A search hit is a lead, not proof (R57): only a copy with the same Message-ID and sender, outside
    // Sent, Drafts, Spam and Trash, counts, and it must be the only one.
    const verified: NylasMessageFull[] = [];
    for (const hit of hits) {
      if (hit.folders.some((f) => EXCLUDED_COPY_FOLDERS.has(f.toUpperCase()))) continue;
      const own = await withTimeout(ownId(target.id, hit.id));
      if (own.id !== rfcId) continue;
      const copy = await withTimeout(other.client.getMessage(hit.id));
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
      const explicit = readMailboxInput(input);
      if (explicit.ok && explicit.mailbox === undefined) {
        const redirect = await addressedCopy(ctx, picked.at, original, replyToMessageId);
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
        if (truncated) {
          ctx.log.warn(
            { threadId: original.threadId, cap: DRAFT_SCAN_LIMIT },
            'ceo-inbox-draft-reply: draft scan hit the cap without finding this thread — refusing to create a draft',
          );
          return {
            success: false,
            error: 'Unable to determine whether this thread already has a draft; draft scan incomplete',
          };
        }
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
