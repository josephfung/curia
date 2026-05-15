// Thin Nylas v3 REST API wrapper for CEO inbox skills.
// Uses fetch() directly — no dependency on the core NylasClient or Nylas SDK.
// This is intentional: the CEO's email is a separate data source accessed via
// dedicated secrets, not through the core's channel account infrastructure.

const NYLAS_BASE = 'https://api.us.nylas.com/v3/grants';

// ── Response types ──────────────────────────────────────────────────────────

export interface NylasParticipant {
  name?: string;
  email: string;
}

export interface NylasMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: NylasParticipant[];
  snippet: string;
  date: number;
  unread: boolean;
  folders: string[];
  attachments: EmailAttachmentMeta[];
}

export interface NylasMessageFull extends NylasMessageSummary {
  to: NylasParticipant[];
  cc: NylasParticipant[];
  bcc: NylasParticipant[];
  body: string;
  labels: string[];
  // attachments is inherited from NylasMessageSummary via extends
}

export interface NylasDraft {
  id: string;
  subject: string;
  to: NylasParticipant[];
  cc: NylasParticipant[];
}

export interface NylasFolder {
  id: string;
  name: string;
}

export interface EmailAttachmentMeta {
  /** Nylas attachment ID — pass to ceo-inbox-download-attachment. */
  id: string;
  /** Original filename (e.g. "receipt.pdf"). */
  filename: string;
  /** MIME type (e.g. "application/pdf"). */
  contentType: string;
  /** Size in bytes. */
  size: number;
}

// ── List options ────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  limit?: number;
  folder?: string;
  unread?: boolean;
  query?: string;
  receivedAfter?: number;
}

// ── Logger interface (matches pino's signature) ─────────────────────────────

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ── Error class ─────────────────────────────────────────────────────────────

export class NylasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'NylasApiError';
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export class CeoNylasClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly log: Logger;

  constructor(apiKey: string, grantId: string, log: Logger) {
    this.baseUrl = `${NYLAS_BASE}/${grantId}`;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    this.log = log;
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async listMessages(options: ListMessagesOptions = {}): Promise<NylasMessageSummary[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.query) {
      // Nylas v3: search_query_native cannot be combined with any other filter
      // param except limit and page_token — sending in/unread/received_after
      // alongside it returns HTTP 400 "invalid_request_error".
      params.set('search_query_native', options.query);
    } else {
      if (options.folder) params.set('in', options.folder);
      if (options.unread !== undefined) params.set('unread', String(options.unread));
      if (options.receivedAfter !== undefined) params.set('received_after', String(options.receivedAfter));
    }

    const url = `${this.baseUrl}/messages?${params}`;
    const data = await this.request<NylasApiMessage[]>('GET', url, 'listMessages');

    return data.map(normalizeMessageSummary);
  }

  async getMessage(messageId: string): Promise<NylasMessageFull> {
    const url = `${this.baseUrl}/messages/${encodeURIComponent(messageId)}`;
    const data = await this.request<NylasApiMessage>('GET', url, 'getMessage');
    return normalizeMessageFull(data);
  }

  // ── Drafts ──────────────────────────────────────────────────────────────

  async createDraftReply(options: {
    replyToMessageId: string;
    subject: string;
    body: string;
    to: NylasParticipant[];
    cc?: NylasParticipant[];
  }): Promise<NylasDraft> {
    const url = `${this.baseUrl}/drafts`;
    const payload: Record<string, unknown> = {
      reply_to_message_id: options.replyToMessageId,
      subject: options.subject,
      body: options.body,
      to: options.to,
    };
    if (options.cc && options.cc.length > 0) {
      payload.cc = options.cc;
    }
    const data = await this.request<NylasApiDraft>('POST', url, 'createDraftReply', payload);
    return {
      id: data.id,
      subject: data.subject ?? '',
      to: (data.to ?? []).map(normParticipant),
      cc: (data.cc ?? []).map(normParticipant),
    };
  }

  // ── Message updates ──────────────────────────────────────────────────────

  async markAsRead(messageId: string): Promise<void> {
    const url = `${this.baseUrl}/messages/${encodeURIComponent(messageId)}`;
    await this.request<NylasApiMessage>('PUT', url, 'markAsRead', { unread: false });
  }

  async updateMessageFolders(
    messageId: string,
    folders: string[],
  ): Promise<{ id: string; folders: string[] }> {
    const url = `${this.baseUrl}/messages/${encodeURIComponent(messageId)}`;
    const payload = { folders };
    const data = await this.request<NylasApiMessage>('PUT', url, 'updateMessageFolders', payload);
    return { id: data.id, folders: data.folders ?? [] };
  }

  // ── Folders ─────────────────────────────────────────────────────────────

  async listFolders(): Promise<NylasFolder[]> {
    const url = `${this.baseUrl}/folders`;
    const data = await this.request<NylasApiFolder[]>('GET', url, 'listFolders');
    return data.map((f) => ({ id: f.id, name: f.name ?? '' }));
  }

  async createFolder(name: string): Promise<NylasFolder> {
    const url = `${this.baseUrl}/folders`;
    const payload = { name };
    const data = await this.request<NylasApiFolder>('POST', url, 'createFolder', payload);
    return { id: data.id, name: data.name ?? name };
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  /**
   * Download a message attachment's raw bytes.
   * Uses a dedicated fetch (not the JSON request<T> wrapper) because the
   * download endpoint returns binary data, not a JSON envelope.
   *
   * @param attachmentId  Nylas attachment ID
   * @param messageId     ID of the message the attachment belongs to (required by Nylas API)
   */
  async downloadAttachment(attachmentId: string, messageId: string): Promise<Buffer> {
    const url = `${this.baseUrl}/attachments/${encodeURIComponent(attachmentId)}/download?message_id=${encodeURIComponent(messageId)}`;
    this.log.debug({ operation: 'downloadAttachment' }, 'nylas: downloadAttachment');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: this.headers.Authorization,
          Accept: 'application/octet-stream',
        },
      });
    } catch (err) {
      this.log.error({ err }, 'nylas: downloadAttachment fetch failed');
      throw new NylasApiError(0, 'downloadAttachment', `Fetch failed: ${String(err)}`);
    }

    if (!res.ok) {
      const text = await res.text().catch((bodyErr) => {
        this.log.warn({ bodyErr, status: res.status }, 'nylas: downloadAttachment could not read error response body');
        return '(unreadable body)';
      });
      this.log.error({ status: res.status }, 'nylas: downloadAttachment API error');
      throw new NylasApiError(
        res.status,
        'downloadAttachment',
        `Nylas downloadAttachment: HTTP ${res.status} — ${text}`,
      );
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await res.arrayBuffer();
    } catch (err) {
      this.log.error({ err }, 'nylas: downloadAttachment body read failed');
      throw new NylasApiError(0, 'downloadAttachment', `Body read failed: ${String(err)}`);
    }
    return Buffer.from(arrayBuffer);
  }

  // ── Internal fetch wrapper ──────────────────────────────────────────────

  private async request<T>(
    method: string,
    url: string,
    operation: string,
    body?: unknown,
  ): Promise<T> {
    this.log.debug({ operation, method }, `nylas: ${operation}`);

    const init: RequestInit = { method, headers: this.headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      this.log.error({ err, operation }, `nylas: ${operation} fetch failed`);
      throw new NylasApiError(0, operation, `Fetch failed: ${String(err)}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '(unreadable body)');
      this.log.error({ status: res.status, operation }, `nylas: ${operation} API error`);
      throw new NylasApiError(res.status, operation, `Nylas ${operation}: HTTP ${res.status} — ${text}`);
    }

    const json = (await res.json()) as { data: T };
    return json.data;
  }
}

// ── Nylas API raw shapes (internal) ─────────────────────────────────────────

interface NylasApiParticipant {
  name?: string;
  email: string;
}

interface NylasApiMessage {
  id: string;
  thread_id?: string;
  subject?: string;
  from?: NylasApiParticipant[];
  to?: NylasApiParticipant[];
  cc?: NylasApiParticipant[];
  bcc?: NylasApiParticipant[];
  body?: string;
  snippet?: string;
  date?: number;
  unread?: boolean;
  folders?: string[];
  labels?: string[];
  attachments?: NylasApiAttachment[];
}

interface NylasApiDraft {
  id: string;
  subject?: string;
  to?: NylasApiParticipant[];
  cc?: NylasApiParticipant[];
}

interface NylasApiFolder {
  id: string;
  name?: string;
}

// Raw attachment shape from the Nylas v3 REST API (snake_case).
interface NylasApiAttachment {
  id: string;
  filename?: string;
  content_type: string;
  size?: number;
  is_inline?: boolean;
  content_disposition?: string;
}

// ── Normalization helpers ───────────────────────────────────────────────────

function normParticipant(p: NylasApiParticipant): NylasParticipant {
  return { name: p.name, email: p.email };
}

function normalizeAttachments(raw?: NylasApiAttachment[]): EmailAttachmentMeta[] {
  if (!raw || raw.length === 0) return [];
  return raw
    .filter((a) => {
      // Exclude inline parts (embedded images, signature graphics, CID-referenced content).
      // Check both fields: providers set either or both depending on their implementation.
      // Use startsWith for contentDisposition to catch 'inline; filename=...' variants.
      const markedInline = a.is_inline === true;
      const dispositionInline =
        typeof a.content_disposition === 'string' &&
        a.content_disposition.toLowerCase().startsWith('inline');
      return !markedInline && !dispositionInline;
    })
    .map((a) => ({
      id: a.id,
      filename: a.filename ?? 'unnamed',
      contentType: a.content_type,
      size: a.size ?? 0,
    }));
}

function normalizeMessageSummary(msg: NylasApiMessage): NylasMessageSummary {
  return {
    id: msg.id,
    threadId: msg.thread_id ?? '',
    subject: msg.subject ?? '',
    from: (msg.from ?? []).map(normParticipant),
    snippet: msg.snippet ?? '',
    date: msg.date ?? 0,
    unread: msg.unread ?? false,
    folders: msg.folders ?? [],
    attachments: normalizeAttachments(msg.attachments),
  };
}

function normalizeMessageFull(msg: NylasApiMessage): NylasMessageFull {
  return {
    ...normalizeMessageSummary(msg),
    to: (msg.to ?? []).map(normParticipant),
    cc: (msg.cc ?? []).map(normParticipant),
    bcc: (msg.bcc ?? []).map(normParticipant),
    body: msg.body ?? '',
    labels: msg.labels ?? msg.folders ?? [],
  };
}

// ── HTML → plain text utility ───────────────────────────────────────────────

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // Strip all complete HTML tags.
    .replace(/<[^>]+>/g, '')
    // Strip incomplete tags — bare <tagname without a closing > is not caught by <[^>]+>
    // above (which requires >). This prevents injected <script fragments from surviving
    // into the plain-text body that is shown to the LLM. {0,500} caps match length to
    // prevent stripping large text bodies on inputs with a lone < far from any >.
    .replace(/<[a-zA-Z][^>]{0,500}/g, '')
    // Decode HTML entities.
    // Order matters: &amp; must be decoded LAST to prevent double-decoding.
    // Decoding &amp; first would turn &amp;lt; into &lt; and then into <,
    // smuggling a literal < into the output.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
