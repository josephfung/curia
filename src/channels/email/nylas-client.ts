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

    this.log.debug({ queryParams }, 'listing messages');

    // The SDK's list() returns an AsyncListResponse which is both a Promise
    // and an async iterable. Awaiting it gives us the first page of results.
    const response = await this.nylas.messages.list({
      identifier: this.grantId,
      queryParams,
    });

    return response.data.map((msg) => this.normalizeMessage(msg));
  }

  /**
   * Fetch a single message by its Nylas message ID.
   */
  async getMessage(messageId: string): Promise<NylasMessage> {
    this.log.debug({ messageId }, 'fetching message');

    const response = await this.nylas.messages.find({
      identifier: this.grantId,
      messageId,
    });

    return this.normalizeMessage(response.data);
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
      to: msg.to.map((p) => ({ name: p.name, email: p.email })),
      cc: (msg.cc ?? []).map((p) => ({ name: p.name, email: p.email })),
      bcc: (msg.bcc ?? []).map((p) => ({ name: p.name, email: p.email })),
      body: msg.body ?? '',
      snippet: msg.snippet ?? '',
      date: msg.date,
      unread: msg.unread ?? false,
      folders: msg.folders,
    };
  }
}
