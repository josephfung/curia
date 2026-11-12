// The Nylas SDK v8's type declarations resolve as CJS under TypeScript's
// nodenext module resolution (their types directory lacks a package.json with
// "type": "module"). This means `export default Nylas` in the .d.ts is seen
// as a CJS namespace rather than a constructable class — even though the
// runtime default import works correctly. We work around this by:
//   1. Importing the default (runtime value is the Nylas class)
//   2. Importing the model/response types that DO resolve correctly
//   3. Defining a minimal NylasLike interface for the instance shape
//   4. Casting the constructor once in our constructor
//
// TODO: Remove this workaround if Nylas ships proper ESM type declarations
// (i.e., adds "type": "module" or .d.mts files in a future release).
import NylasDefault from 'nylas';
import type {
  Message as NylasSdkMessage,
  Folder as NylasSdkFolder,
  ListMessagesQueryParams,
  NylasResponse,
  NylasListResponse,
  SendMessageRequest,
  CreateFolderRequest,
  MessageFields,
  Draft as NylasDraft,
  CreateDraftRequest,
  CreateAttachmentRequest,
  ListFolderQueryParams,
  ListDraftsQueryParams,
} from 'nylas';
import type { Logger } from '../../logger.js';
import { budgetExpired, remainingMs } from '../../util/call-budget.js';
import type { CallBudget } from '../../util/call-budget.js';
import { markMessageRequestError, nylasStatus } from './nylas-message-id.js';
import { withoutReadOnlySystemLabels } from './system-labels.js';

/** Per-request SDK options. `timeout` caps one request (see budgetOverrides). */
interface RequestOverrides {
  overrides?: { timeout: number };
}

// How long a folder list is reused. email-label needs one on every call, and
// folders change rarely. createFolder drops the cache, so a new label is seen
// at once (#2083).
const FOLDER_CACHE_TTL_MS = 5 * 60_000;
// Ceiling for listFolders paging, so a cursor that never ends cannot loop.
const FOLDER_SCAN_LIMIT = 500;

/**
 * Minimal typed interface for the Nylas SDK instance. We only declare the
 * subset of the API surface that this wrapper actually uses, so the
 * workaround stays small and easy to verify against the real SDK.
 */
interface NylasLike {
  messages: {
    list(params: {
      identifier: string;
      queryParams?: ListMessagesQueryParams;
    }): Promise<NylasListResponse<NylasSdkMessage>>;

    find(params: {
      identifier: string;
      messageId: string;
      queryParams?: { fields?: MessageFields };
    } & RequestOverrides): Promise<NylasResponse<NylasSdkMessage>>;

    send(params: {
      identifier: string;
      requestBody: SendMessageRequest;
    }): Promise<NylasResponse<NylasSdkMessage>>;

    /** Used by archiveMessage() to remove the INBOX label when archiving a message. */
    update(params: {
      identifier: string;
      messageId: string;
      requestBody: { folders?: string[]; starred?: boolean; unread?: boolean };
    } & RequestOverrides): Promise<NylasResponse<NylasSdkMessage>>;
  };
  drafts: {
    create(params: {
      identifier: string;
      requestBody: CreateDraftRequest;
    }): Promise<NylasResponse<NylasDraft>>;

    /** Drafts live in their own collection: `/messages` never returns them (#2262). */
    list(params: {
      identifier: string;
      queryParams?: ListDraftsQueryParams;
    }): Promise<NylasListResponse<NylasDraft>>;

    find(params: {
      identifier: string;
      draftId: string;
    }): Promise<NylasResponse<NylasDraft>>;

    /**
     * Send an existing draft by ID. Nylas delivers the draft as-is (full envelope
     * preserved) and removes it from the DRAFTS folder after sending.
     * Returns the sent Message, not a Draft.
     */
    send(params: {
      identifier: string;
      draftId: string;
    }): Promise<NylasResponse<NylasSdkMessage>>;

    /** Remove a draft. A 404 means it is already gone. */
    destroy(params: {
      identifier: string;
      draftId: string;
    }): Promise<unknown>;
  };
  folders: {
    list(params: {
      identifier: string;
      queryParams?: ListFolderQueryParams;
    } & RequestOverrides): Promise<NylasListResponse<NylasSdkFolder>>;

    create(params: {
      identifier: string;
      requestBody: CreateFolderRequest;
    } & RequestOverrides): Promise<NylasResponse<NylasSdkFolder>>;
  };
  grants: {
    find(args: { grantId: string }): Promise<{ data: { email?: string; provider?: string } }>;
  };
  attachments: {
    downloadBytes(params: {
      identifier: string;
      attachmentId: string;
      queryParams: { messageId: string };
    }): Promise<Buffer>;
  };
}

/**
 * The Nylas default export is a class constructor at runtime.
 * Cast it through unknown so TypeScript treats it as constructable.
 */
const NylasSDK = NylasDefault as unknown as new (config: { apiKey: string; timeout?: number }) => NylasLike;

// ---------------------------------------------------------------------------
// Our own simplified message shape — normalized from the Nylas SDK's Message
// type. Many SDK fields are optional; we default them to safe values so
// downstream consumers don't have to null-check everything.
// ---------------------------------------------------------------------------

export interface NylasMessage {
  id: string;
  threadId: string;
  subject: string;
  from: Array<{ name?: string; email: string }>;
  to: Array<{ name?: string; email: string }>;
  cc: Array<{ name?: string; email: string }>;
  bcc: Array<{ name?: string; email: string }>;
  body: string;
  snippet: string;
  date: number;
  unread: boolean;
  folders: string[];
  /**
   * Email headers — only present when the fetch asked for fields: 'include_headers'
   * (listMessages, or getMessage with includeHeaders). Used to read
   * Authentication-Results for SPF/DKIM/DMARC validation.
   */
  headers?: Array<{ name: string; value: string }>;
  /** Non-inline file attachments. Empty array when no attachments are present. */
  attachments: EmailAttachment[];
}

/** Metadata for a non-inline file attachment on an inbound email. */
export interface EmailAttachment {
  /** Nylas attachment ID — required for downloading via the Attachments API. */
  id: string;
  /** Original filename (e.g. "report.pdf"). */
  filename: string;
  /** MIME type (e.g. "application/pdf", "image/jpeg"). */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** True when the attachment is a calendar invite payload (ICS / text/calendar). */
  isCalendarInvite?: boolean;
}

/**
 * Simplified folder/label shape — normalized from the Nylas SDK's Folder type.
 * Used by skills that need to list, create, or reference email folders.
 */
export interface NylasFolder {
  id: string;
  name: string;
  /**
   * Provider-neutral system-folder markers from Nylas, e.g. `\Sent` on the Sent folder
   * whatever its id or name (Gmail `SENT`, Outlook "Sent Items"). Absent on user folders.
   */
  attributes?: string[];
}

/**
 * A resolved attachment ready to include in an outbound send or draft.
 * Content is raw bytes — the caller is responsible for reading the file
 * before constructing this object (see readAttachmentFiles in read-attachments.ts).
 */
export interface AttachmentContent {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SendEmailOptions {
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  subject: string;
  body: string;
  replyToMessageId?: string;
  /** File attachments to include. Each entry's content is passed as-is to Nylas. */
  attachments?: AttachmentContent[];
}

export interface ListMessagesOptions {
  /** Unix timestamp — only return messages received after this time */
  receivedAfter?: number;
  /** When true, only return unread messages */
  unread?: boolean;
  /** Max number of messages to return (default 50, max 200 per Nylas) */
  limit?: number;
  /** Filter messages to a specific thread ID — used when looking up a reply target */
  threadId?: string;
  /**
   * When set to 'include_headers', the Nylas API returns raw email headers in the response.
   * Required to access Authentication-Results for SPF/DKIM/DMARC sender verification.
   */
  fields?: 'include_headers';
  /** Filter to messages in these folder IDs (maps to Nylas `in` param).
   *  Standard Gmail values: INBOX, DRAFT, SENT, TRASH, SPAM, STARRED, IMPORTANT.
   *  DRAFT or DRAFTS alone lists drafts instead (see listMessages). */
  folders?: string[];
  /** Filter to messages from this sender email address */
  from?: string;
  /** Filter to messages with this address in from, to, cc or bcc (Nylas `any_email`) */
  anyEmail?: string;
  /** Filter to messages with this exact subject line */
  subject?: string;
  /** Provider-native search query (Gmail search syntax, Outlook KQL, etc.) */
  searchQueryNative?: string;
}

/**
 * A drafts listing asked for a filter the drafts query has no equivalent for. Drafts
 * are all from the mailbox owner and have no received date, so `from` and
 * `receivedAfter` cannot be applied; `fields` (headers) is a messages-only option.
 */
export class UnsupportedDraftsFilterError extends Error {
  constructor(readonly filters: readonly string[]) {
    super(
      `Listing drafts cannot filter by ${filters.join(', ')}: drafts are all from this mailbox and have no ` +
      'received date. Drop that filter, or filter by subject.',
    );
    this.name = 'UnsupportedDraftsFilterError';
  }
}

/** True for the folder names callers use for drafts: Gmail's DRAFT, or DRAFTS. */
export function isDraftsFolder(folder: string): boolean {
  const name = folder.trim().toUpperCase();
  return name === 'DRAFT' || name === 'DRAFTS';
}

// ---------------------------------------------------------------------------
// NylasClient — thin wrapper that hides SDK details and provides typed,
// normalized responses for the operations the email channel needs.
// ---------------------------------------------------------------------------

export class NylasClient {
  private readonly nylas: NylasLike;
  private readonly grantId: string;
  private readonly log: Logger;
  // This client is long-lived and bound to one grant, so the cache is per grant.
  private folderCache: { folders: NylasFolder[]; expiresAt: number } | undefined;

  /**
   * `timeoutMs` caps every request this client makes (the SDK default is 90s). The SDK
   * config takes seconds. Leave it unset for the long-lived channel clients.
   */
  constructor(apiKey: string, grantId: string, logger: Logger, timeoutMs?: number) {
    this.nylas = new NylasSDK({
      apiKey,
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs / 1000 }),
    });
    this.grantId = grantId;
    this.log = logger.child({ component: 'nylas-client' });
  }

  /**
   * Read this grant's own address and provider from Nylas (#2475). The email is
   * lowercased. SDK errors (404 for a revoked grant, etc.) propagate unchanged.
   */
  async getGrant(): Promise<{ email: string; provider: string }> {
    let data: { email?: string; provider?: string };
    try {
      ({ data } = await this.nylas.grants.find({ grantId: this.grantId }));
    } catch (err) {
      // The grant id is a credential: neither this log line nor the thrown message carries it.
      this.log.error(
        { errName: err instanceof Error ? err.name : 'unknown', statusCode: (err as { statusCode?: number }).statusCode },
        'Nylas grants.find failed',
      );
      throw err;
    }
    if (!data.email) {
      throw new Error('The Nylas grant has no email address');
    }
    return { email: data.email.toLowerCase(), provider: data.provider ?? '' };
  }

  /**
   * List recent messages, optionally filtered by time / read-state / count.
   *
   * Results are ordered newest-first (most-recent-first) per the Nylas API
   * default. Callers that rely on messages[0] being the latest message in a
   * thread (e.g. email-adapter's sendOutboundReply) depend on this guarantee.
   */
  async listMessages(options?: ListMessagesOptions): Promise<NylasMessage[]> {
    // Gmail rejects `in=DRAFTS` (its label is DRAFT), and `/messages` has no drafts
    // under either name, so a drafts-only folder filter reads `/drafts` (#2262).
    const folders = options?.folders;
    if (folders && folders.length > 0 && folders.every(isDraftsFolder)) {
      if (options?.searchQueryNative === undefined) {
        // A filter the drafts query cannot apply is refused: an unfiltered page
        // returned as the filtered set is worse than an error.
        const unsupported = (['from', 'receivedAfter', 'fields'] as const).filter((key) => options?.[key] !== undefined);
        if (unsupported.length > 0) throw new UnsupportedDraftsFilterError(unsupported);
        return this.listDrafts({
          limit: options?.limit,
          threadId: options?.threadId,
          subject: options?.subject,
          unread: options?.unread,
          anyEmail: options?.anyEmail,
        });
      }
      // A native search runs on /messages and drops folders (below), so it never lists drafts.
      this.log.warn('nylas: listMessages — drafts folder ignored because searchQueryNative is set; this searches messages, not drafts');
    }

    const queryParams: ListMessagesQueryParams = {};

    if (options?.limit !== undefined) {
      queryParams.limit = options.limit;
    }
    if (options?.threadId !== undefined) {
      queryParams.threadId = options.threadId;
    }
    if (options?.fields !== undefined) {
      // Cast needed: our interface uses a string literal to avoid leaking the SDK's
      // MessageFields enum type into the broader codebase.
      queryParams.fields = options.fields as MessageFields;
    }

    if (options?.searchQueryNative !== undefined) {
      // Nylas v3: search_query_native cannot be combined with any other filter
      // param except limit and page_token — sending in/unread/received_after/from/
      // subject alongside it returns HTTP 400. Suppress conflicting params and warn
      // when the caller passed both. (Same guard as CeoNylasClient.)
      const suppressed: Record<string, unknown> = {};
      if (options.folders !== undefined) suppressed.folders = options.folders;
      if (options.unread !== undefined) suppressed.unread = options.unread;
      if (options.receivedAfter !== undefined) suppressed.receivedAfter = options.receivedAfter;
      if (options.from !== undefined) suppressed.from = options.from;
      if (options.anyEmail !== undefined) suppressed.anyEmail = options.anyEmail;
      if (options.subject !== undefined) suppressed.subject = options.subject;
      if (Object.keys(suppressed).length > 0) {
        this.log.warn(
          { suppressed },
          'nylas: listMessages — folders/unread/receivedAfter/from/anyEmail/subject ignored because searchQueryNative is set (Nylas v3 limitation)',
        );
      }
      queryParams.searchQueryNative = options.searchQueryNative;
    } else {
      if (options?.receivedAfter !== undefined) {
        queryParams.receivedAfter = options.receivedAfter;
      }
      if (options?.unread !== undefined) {
        queryParams.unread = options.unread;
      }
      if (options?.folders !== undefined) {
        // Nylas uses `in` for folder filtering — maps to our `folders` option.
        queryParams.in = options.folders;
      }
      if (options?.from !== undefined) {
        // Nylas expects `from` as an array of email strings.
        queryParams.from = [options.from];
      }
      if (options?.anyEmail !== undefined) {
        queryParams.anyEmail = [options.anyEmail];
      }
      if (options?.subject !== undefined) {
        queryParams.subject = options.subject;
      }
    }

    this.log.debug({ queryParams }, 'listing messages');

    // The SDK's list() returns an AsyncListResponse which is both a Promise
    // and an async iterable. Awaiting it gives us the first page of results.
    try {
      const response = await this.nylas.messages.list({
        identifier: this.grantId,
        queryParams,
      });
      return response.data.map((msg) => this.normalizeMessage(msg));
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, queryParams }, 'Nylas listMessages failed');
      throw err;
    }
  }

  /** List unsent drafts, newest first (first page only, like listMessages). */
  async listDrafts(
    options?: { limit?: number; threadId?: string; subject?: string; unread?: boolean; anyEmail?: string },
  ): Promise<NylasMessage[]> {
    const queryParams: ListDraftsQueryParams = {};
    if (options?.limit !== undefined) queryParams.limit = options.limit;
    if (options?.threadId !== undefined) queryParams.threadId = options.threadId;
    if (options?.subject !== undefined) queryParams.subject = options.subject;
    if (options?.unread !== undefined) queryParams.unread = options.unread;
    // The drafts query has any_email too, so the address filter carries over (#2268 review).
    if (options?.anyEmail !== undefined) queryParams.anyEmail = [options.anyEmail];

    try {
      const response = await this.nylas.drafts.list({ identifier: this.grantId, queryParams });
      // Draft and Message share BaseMessage, as in createDraft.
      return response.data.map((draft) => this.normalizeMessage(draft as unknown as NylasSdkMessage));
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, queryParams }, 'Nylas listDrafts failed');
      throw err;
    }
  }

  /** Fetch one draft by ID, or null when this mailbox has no such draft. */
  async getDraft(draftId: string): Promise<NylasMessage | null> {
    try {
      const response = await this.nylas.drafts.find({ identifier: this.grantId, draftId });
      return this.normalizeMessage(response.data as unknown as NylasSdkMessage);
    } catch (err) {
      if (nylasStatus(err) === 404) {
        this.log.debug({ grantId: this.grantId, draftId }, 'Nylas getDraft: no such draft');
        return null;
      }
      this.log.error({ err, grantId: this.grantId, draftId }, 'Nylas getDraft failed');
      throw err;
    }
  }

  /**
   * Fetch a single message by its Nylas message ID.
   * `includeHeaders` asks Nylas for Authentication-Results. The gateway's
   * getEmailMessage always sets it so a cached fetch still carries them (#2071).
   */
  async getMessage(
    messageId: string,
    options?: { includeHeaders?: boolean; budget?: CallBudget },
  ): Promise<NylasMessage> {
    this.log.debug({ messageId, includeHeaders: options?.includeHeaders }, 'fetching message');

    try {
      const response = await this.nylas.messages.find({
        identifier: this.grantId,
        messageId,
        ...(options?.includeHeaders ? { queryParams: { fields: 'include_headers' as MessageFields } } : {}),
        ...this.budgetOverrides(options?.budget, 'getMessage'),
      });
      return this.normalizeMessage(response.data);
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas getMessage failed');
      throw markMessageRequestError(err);
    }
  }

  /**
   * Send an email — either a brand-new message or a reply to an existing one.
   * When `replyToMessageId` is set, Nylas threads the reply automatically.
   */
  async sendMessage(options: SendEmailOptions): Promise<NylasMessage> {
    this.log.debug(
      { to: options.to, subject: options.subject, isReply: !!options.replyToMessageId },
      'sending message',
    );

    try {
      const attachments: CreateAttachmentRequest[] | undefined = options.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      }));
      const response = await this.nylas.messages.send({
        identifier: this.grantId,
        requestBody: {
          to: options.to,
          cc: options.cc,
          subject: options.subject,
          body: options.body,
          replyToMessageId: options.replyToMessageId,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
      });
      return this.normalizeMessage(response.data);
    } catch (err) {
      this.log.error(
        { err, grantId: this.grantId, to: options.to, subject: options.subject, isReply: !!options.replyToMessageId },
        'Nylas sendMessage failed',
      );
      throw err;
    }
  }

  /**
   * Save an email as a draft (without sending). Used as a fallback when the autonomy
   * gate blocks a direct send, creating a draft for human review.
   *
   * Draft and Message share the same BaseMessage shape in the Nylas SDK, so the
   * response can be normalised with the same helper as a sent message.
   *
   * Drafts are created silently — no per-draft notification is sent. The principal discovers
   * pending drafts via the end-of-day Signal digest and reviews them in Gmail (#403, #278).
   */
  async createDraft(options: SendEmailOptions): Promise<NylasMessage> {
    this.log.debug(
      { to: options.to, subject: options.subject, isReply: !!options.replyToMessageId },
      'creating draft',
    );

    try {
      const attachments: CreateAttachmentRequest[] | undefined = options.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      }));
      const response = await this.nylas.drafts.create({
        identifier: this.grantId,
        requestBody: {
          to: options.to,
          cc: options.cc,
          subject: options.subject,
          body: options.body,
          replyToMessageId: options.replyToMessageId,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
      });
      // Draft and NylasSdkMessage (Message) both extend BaseMessage — the fields we
      // normalise (id, threadId, subject, from, to, cc, body, etc.) are present on both.
      return this.normalizeMessage(response.data as unknown as NylasSdkMessage);
    } catch (err) {
      this.log.error(
        { err, grantId: this.grantId, to: options.to, subject: options.subject, isReply: !!options.replyToMessageId },
        'Nylas createDraft failed',
      );
      throw err;
    }
  }

  /**
   * Send an existing Nylas draft by its ID.
   *
   * Calls the Nylas `POST /v3/grants/{grant_id}/drafts/{draft_id}/send` endpoint which:
   *   1. Sends the draft with its full envelope (To/CC/BCC preserved as stored)
   *   2. Removes the draft from the DRAFTS folder
   *   3. Honours any `replyToMessageId` embedded in the draft for correct threading
   *
   * Used by the send-draft skill when the principal authorizes sending an existing draft.
   */
  async sendDraft(draftId: string): Promise<NylasMessage> {
    this.log.debug({ draftId }, 'sending draft');

    try {
      const response = await this.nylas.drafts.send({
        identifier: this.grantId,
        draftId,
      });
      return this.normalizeMessage(response.data);
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, draftId }, 'Nylas sendDraft failed');
      throw err;
    }
  }

  /**
   * Delete a mailbox draft. A 404 is success: the draft is already gone, so a
   * discarded approval cannot send it. Any other failure is rethrown.
   */
  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this.nylas.drafts.destroy({ identifier: this.grantId, draftId });
    } catch (err) {
      if (nylasStatus(err) === 404) {
        this.log.info({ draftId }, 'Nylas deleteDraft: draft already gone');
        return;
      }
      this.log.error({ err, grantId: this.grantId, draftId }, 'Nylas deleteDraft failed');
      throw err;
    }
  }

  /**
   * Archive a message by removing it from the INBOX folder.
   *
   * For Gmail (via Nylas), removing INBOX moves the message to "All Mail" —
   * the standard archive. Other providers remove the INBOX folder equivalently.
   *
   * Two API calls: getMessage (to read current folders) then messages.update
   * (to write back folders without INBOX). The fetch-then-update approach
   * preserves non-INBOX labels (STARRED, IMPORTANT, custom labels) that
   * would be lost if we blindly set folders: [].
   */
  async archiveMessage(messageId: string, budget?: CallBudget): Promise<void> {
    this.log.debug({ messageId }, 'archiving message');

    // Split into two try blocks so log messages accurately identify which API call failed.
    // getMessage already logs its own error; re-throwing without a second log avoids
    // misleading 'archiveMessage failed' entries when it's actually a fetch failure.
    let currentFolders: string[];
    let hadInbox: boolean;
    try {
      const current = await this.getMessage(messageId, { budget });
      // Filter by uppercase so we catch 'inbox', 'Inbox', 'INBOX' consistently
      currentFolders = current.folders.filter((f) => f.toUpperCase() !== 'INBOX');
      // True if the filter actually removed something — avoids a no-op API call
      hadInbox = currentFolders.length !== current.folders.length;
    } catch (err) {
      // getMessage already logged; re-throw without a second log line
      throw err;
    }

    if (!hadInbox) {
      this.log.debug({ messageId }, 'archive skipped: INBOX label not present');
      return;
    }

    try {
      await this.nylas.messages.update({
        identifier: this.grantId,
        messageId,
        requestBody: { folders: withoutReadOnlySystemLabels(currentFolders) },
        ...this.budgetOverrides(budget, 'archiveMessage'),
      });
      this.log.info({ messageId, updatedFolders: currentFolders }, 'message archived successfully');
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas messages.update failed during archive');
      throw markMessageRequestError(err);
    }
  }

  /**
   * Mark a message as read by setting its unread flag to false.
   */
  async markAsRead(messageId: string, budget?: CallBudget): Promise<void> {
    this.log.debug({ messageId }, 'marking message as read');

    try {
      await this.nylas.messages.update({
        identifier: this.grantId,
        messageId,
        requestBody: { unread: false },
        ...this.budgetOverrides(budget, 'markAsRead'),
      });
      this.log.info({ messageId }, 'message marked as read');
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas markAsRead failed');
      throw markMessageRequestError(err);
    }
  }

  /**
   * List all folders/labels in the email account.
   * For Gmail, this returns both system folders (INBOX, SENT, etc.) and user-created labels.
   *
   * Follows `next_cursor` to the last page: a label past page 1 used to be
   * missed, and email-label then created a duplicate (#2083). Cached for
   * FOLDER_CACHE_TTL_MS; returns a copy so a caller cannot edit the cache.
   */
  async listFolders(budget?: CallBudget): Promise<NylasFolder[]> {
    if (this.folderCache && this.folderCache.expiresAt > Date.now()) {
      return [...this.folderCache.folders];
    }
    this.log.debug('listing folders');

    const folders: NylasFolder[] = [];
    let pageToken: string | undefined;
    try {
      for (;;) {
        const response = await this.nylas.folders.list({
          identifier: this.grantId,
          ...(pageToken ? { queryParams: { pageToken } } : {}),
          ...this.budgetOverrides(budget, 'listFolders'),
        });
        folders.push(...response.data.map((f) => ({
          id: f.id,
          name: f.name,
          ...(f.attributes?.length ? { attributes: f.attributes } : {}),
        })));

        // An empty page with a cursor would otherwise spin forever.
        if (response.data.length === 0 || !response.nextCursor) break;
        if (folders.length >= FOLDER_SCAN_LIMIT) {
          this.log.warn({ cap: FOLDER_SCAN_LIMIT }, 'nylas: listFolders hit the scan cap with more pages remaining');
          break;
        }
        pageToken = response.nextCursor;
      }
    } catch (err) {
      this.log.error({ err, grantId: this.grantId }, 'Nylas listFolders failed');
      throw err;
    }

    this.folderCache = { folders, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS };
    return [...folders];
  }

  /**
   * Create a new folder/label. For Gmail, this creates a user label.
   */
  async createFolder(name: string, budget?: CallBudget): Promise<NylasFolder> {
    this.log.debug({ name }, 'creating folder');

    try {
      const response = await this.nylas.folders.create({
        identifier: this.grantId,
        requestBody: { name },
        ...this.budgetOverrides(budget, 'createFolder'),
      });
      this.folderCache = undefined;
      this.log.info({ folderId: response.data.id, name }, 'folder created');
      return { id: response.data.id, name: response.data.name };
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, name }, 'Nylas createFolder failed');
      throw err;
    }
  }

  /**
   * Replace a message's folder list with the given folder IDs.
   *
   * This is a low-level operation — callers are responsible for preserving
   * existing folders they want to keep. See OutboundGateway.labelEmailMessage()
   * for the higher-level label-resolution-and-merge workflow.
   */
  async updateMessageFolders(messageId: string, folders: string[], budget?: CallBudget): Promise<NylasMessage> {
    this.log.debug({ messageId, folders }, 'updating message folders');

    try {
      const response = await this.nylas.messages.update({
        identifier: this.grantId,
        messageId,
        requestBody: { folders: withoutReadOnlySystemLabels(folders) },
        ...this.budgetOverrides(budget, 'updateMessageFolders'),
      });
      this.log.info({ messageId, folders }, 'message folders updated');
      return this.normalizeMessage(response.data);
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas updateMessageFolders failed');
      throw markMessageRequestError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * SDK request options for a call made inside a tool call's budget (#2083).
   *
   * Throws once the budget is spent, so a timed-out tool call sends no further
   * request. Otherwise caps the SDK's own request timeout at the time left, which
   * aborts the request when the tool call times out (SDK 8.4 takes no external
   * AbortSignal). The SDK reads a timeout of 1000 or more as milliseconds and a
   * smaller one as seconds, so a sub-second remainder is passed in seconds.
   */
  private budgetOverrides(budget: CallBudget | undefined, operation: string): RequestOverrides {
    if (budgetExpired(budget)) {
      throw new Error(`Nylas ${operation}: cancelled because the tool call timed out`);
    }
    const leftMs = remainingMs(budget);
    if (!Number.isFinite(leftMs)) return {};
    return { overrides: { timeout: leftMs >= 1000 ? leftMs : leftMs / 1000 } };
  }

  /**
   * Convert the SDK's Message type (with many optional fields) into our
   * NylasMessage shape where every field has a guaranteed value.
   */
  private normalizeMessage(msg: NylasSdkMessage): NylasMessage {
    return {
      id: msg.id,
      threadId: msg.threadId ?? '',
      subject: msg.subject ?? '',
      from: (msg.from ?? []).map((p) => ({ name: p.name, email: p.email })),
      to: (msg.to ?? []).map((p) => ({ name: p.name, email: p.email })),
      cc: (msg.cc ?? []).map((p) => ({ name: p.name, email: p.email })),
      bcc: (msg.bcc ?? []).map((p) => ({ name: p.name, email: p.email })),
      body: msg.body ?? '',
      snippet: msg.snippet ?? '',
      date: msg.date,
      unread: msg.unread ?? false,
      folders: msg.folders ?? [],
      // headers is only present when the request included fields: 'include_headers'
      headers: msg.headers?.map((h) => ({ name: h.name, value: h.value })),
      // Filter out inline images (e.g. embedded logos) — only surface real file attachments.
      // The Nylas SDK marks inline parts with isInline: true or contentDisposition: 'inline'.
      attachments: (() => {
        const allAttachments = msg.attachments ?? [];
        const attachments = allAttachments
          .filter((a) => {
            // Exclude inline attachments (embedded images, email signature graphics, CID parts).
            // Check both fields: providers set either one or both depending on their implementation.
            const markedInline = a.isInline === true;
            const dispositionInline =
              typeof a.contentDisposition === 'string' &&
              a.contentDisposition.toLowerCase().startsWith('inline');
            return !markedInline && !dispositionInline;
          })
          .map((a) => ({
            id: a.id,
            filename: a.filename ?? 'unnamed',
            contentType: a.contentType ?? 'application/octet-stream',
            size: a.size ?? 0,
            ...(isCalendarInviteAttachment(a.filename, a.contentType) ? { isCalendarInvite: true } : {}),
          }));
        if (allAttachments.length > attachments.length) {
          this.log.debug(
            { messageId: msg.id, filtered: allAttachments.length - attachments.length },
            'nylas: filtered out inline attachments',
          );
        }
        return attachments;
      })(),
    };
  }

  /**
   * Download a message attachment's raw bytes.
   *
   * @param attachmentId  Nylas attachment ID (from NylasMessage.attachments[].id)
   * @param messageId     ID of the message the attachment belongs to (required by Nylas API)
   */
  async downloadAttachment(attachmentId: string, messageId: string): Promise<Buffer> {
    this.log.debug({ attachmentId, messageId }, 'nylas: downloading attachment');
    try {
      return await this.nylas.attachments.downloadBytes({
        identifier: this.grantId,
        attachmentId,
        queryParams: { messageId },
      });
    } catch (err) {
      this.log.error({ err, attachmentId, messageId }, 'nylas: downloadAttachment failed');
      throw err;
    }
  }
}

function isCalendarInviteAttachment(filename: string | undefined, contentType: string | undefined): boolean {
  const lowerType = (contentType?.split(';', 1)[0] ?? '').trim().toLowerCase();
  const lowerName = filename?.toLowerCase() ?? '';
  return lowerType === 'text/calendar' ||
    lowerType === 'application/ics' ||
    lowerType === 'text/x-vcalendar' ||
    lowerName.endsWith('.ics');
}
