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
  ListMessagesQueryParams,
  NylasResponse,
  NylasListResponse,
  SendMessageRequest,
  MessageFields,
  Draft as NylasDraft,
  CreateDraftRequest,
} from 'nylas';
import type { Logger } from '../../logger.js';

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
    }): Promise<NylasResponse<NylasSdkMessage>>;

    send(params: {
      identifier: string;
      requestBody: SendMessageRequest;
    }): Promise<NylasResponse<NylasSdkMessage>>;

    /** Used by archiveMessage() to remove the INBOX label when archiving a message. */
    update(params: {
      identifier: string;
      messageId: string;
      requestBody: { folders?: string[]; starred?: boolean; unread?: boolean };
    }): Promise<NylasResponse<NylasSdkMessage>>;
  };
  drafts: {
    create(params: {
      identifier: string;
      requestBody: CreateDraftRequest;
    }): Promise<NylasResponse<NylasDraft>>;
  };
}

/**
 * The Nylas default export is a class constructor at runtime.
 * Cast it through unknown so TypeScript treats it as constructable.
 */
const NylasSDK = NylasDefault as unknown as new (config: { apiKey: string }) => NylasLike;

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
   * Email headers — only present when listMessages was called with fields: 'include_headers'.
   * Used by the email adapter to extract Authentication-Results for SPF/DKIM/DMARC validation.
   */
  headers?: Array<{ name: string; value: string }>;
}

export interface SendEmailOptions {
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  subject: string;
  body: string;
  replyToMessageId?: string;
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
   *  Standard values: INBOX, DRAFTS, SENT, TRASH. Providers may have custom labels. */
  folders?: string[];
  /** Filter to messages from this sender email address */
  from?: string;
  /** Filter to messages with this exact subject line */
  subject?: string;
  /** Provider-native search query (Gmail search syntax, Outlook KQL, etc.) */
  searchQueryNative?: string;
}

// ---------------------------------------------------------------------------
// NylasClient — thin wrapper that hides SDK details and provides typed,
// normalized responses for the operations the email channel needs.
// ---------------------------------------------------------------------------

export class NylasClient {
  private readonly nylas: NylasLike;
  private readonly grantId: string;
  private readonly log: Logger;

  constructor(apiKey: string, grantId: string, logger: Logger) {
    this.nylas = new NylasSDK({ apiKey });
    this.grantId = grantId;
    this.log = logger.child({ component: 'nylas-client' });
  }

  /**
   * List recent messages, optionally filtered by time / read-state / count.
   *
   * Results are ordered newest-first (most-recent-first) per the Nylas API
   * default. Callers that rely on messages[0] being the latest message in a
   * thread (e.g. email-adapter's sendOutboundReply) depend on this guarantee.
   */
  async listMessages(options?: ListMessagesOptions): Promise<NylasMessage[]> {
    const queryParams: ListMessagesQueryParams = {};

    if (options?.receivedAfter !== undefined) {
      queryParams.receivedAfter = options.receivedAfter;
    }
    if (options?.unread !== undefined) {
      queryParams.unread = options.unread;
    }
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
    if (options?.folders !== undefined) {
      // Nylas uses `in` for folder filtering — maps to our `folders` option.
      queryParams.in = options.folders;
    }
    if (options?.from !== undefined) {
      // Nylas expects `from` as an array of email strings.
      queryParams.from = [options.from];
    }
    if (options?.subject !== undefined) {
      queryParams.subject = options.subject;
    }
    if (options?.searchQueryNative !== undefined) {
      queryParams.searchQueryNative = options.searchQueryNative;
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

  /**
   * Fetch a single message by its Nylas message ID.
   */
  async getMessage(messageId: string): Promise<NylasMessage> {
    this.log.debug({ messageId }, 'fetching message');

    try {
      const response = await this.nylas.messages.find({
        identifier: this.grantId,
        messageId,
      });
      return this.normalizeMessage(response.data);
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas getMessage failed');
      throw err;
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
      const response = await this.nylas.messages.send({
        identifier: this.grantId,
        requestBody: {
          to: options.to,
          cc: options.cc,
          subject: options.subject,
          body: options.body,
          replyToMessageId: options.replyToMessageId,
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
   * Save an email as a draft (without sending). Used by the 'draft_gate' outbound
   * policy to hold replies for human review before they leave Curia's mailbox.
   *
   * Draft and Message share the same BaseMessage shape in the Nylas SDK, so the
   * response can be normalised with the same helper as a sent message.
   *
   * Drafts are created silently — no per-draft notification is sent. The CEO discovers
   * pending drafts via the end-of-day Signal digest and reviews them in Gmail (#403, #278).
   */
  async createDraft(options: SendEmailOptions): Promise<NylasMessage> {
    this.log.debug(
      { to: options.to, subject: options.subject, isReply: !!options.replyToMessageId },
      'creating draft',
    );

    try {
      const response = await this.nylas.drafts.create({
        identifier: this.grantId,
        requestBody: {
          to: options.to,
          cc: options.cc,
          subject: options.subject,
          body: options.body,
          replyToMessageId: options.replyToMessageId,
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
  async archiveMessage(messageId: string): Promise<void> {
    this.log.debug({ messageId }, 'archiving message');

    // Split into two try blocks so log messages accurately identify which API call failed.
    // getMessage already logs its own error; re-throwing without a second log avoids
    // misleading 'archiveMessage failed' entries when it's actually a fetch failure.
    let currentFolders: string[];
    let hadInbox: boolean;
    try {
      const current = await this.getMessage(messageId);
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
        requestBody: { folders: currentFolders },
      });
      this.log.info({ messageId, updatedFolders: currentFolders }, 'message archived successfully');
    } catch (err) {
      this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas messages.update failed during archive');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
    };
  }
}
