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
  // to and cc are included in list responses by the Nylas v3 API. Needed by
  // the Sent folder sweep (issue #633) so the contacts agent can collect recipient
  // addresses without a separate getMessage() call per message.
  to: NylasParticipant[];
  cc: NylasParticipant[];
  snippet: string;
  date: number;
  unread: boolean;
  folders: string[];
  attachments: EmailAttachmentMeta[];
}

export interface NylasMessageFull extends NylasMessageSummary {
  // to and cc are inherited from NylasMessageSummary
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

/**
 * A resolved outbound attachment ready to include in a draft.
 * Content is raw bytes — callers must read the file before constructing this.
 */
export interface DraftAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

// ── List options ────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  limit?: number;
  folder?: string;
  unread?: boolean;
  query?: string;
  receivedAfter?: number;
}

// Gmail system labels use specific IDs that don't always match the display
// name shown in the Gmail UI.  LLMs (and humans) commonly use the display
// name or a plausible variation.  This map normalizes the most frequent
// mismatches so callers don't need to know the exact Gmail label ID.
const GMAIL_FOLDER_ALIASES: Record<string, string> = {
  DRAFTS: 'DRAFT',     // Gmail UI: "Drafts" → API label: DRAFT
  STARRED: 'STARRED',  // No-op — already correct, listed for completeness
};

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
      if (options.folder || options.unread !== undefined || options.receivedAfter !== undefined) {
        this.log.warn(
          { suppressedOptions: { folder: options.folder, unread: options.unread, receivedAfter: options.receivedAfter } },
          'nylas: listMessages — folder/unread/receivedAfter ignored because search_query_native is set (Nylas v3 limitation)',
        );
      }
      params.set('search_query_native', options.query);
    } else {
      if (options.folder) {
        const normalized = GMAIL_FOLDER_ALIASES[options.folder] ?? options.folder;
        if (normalized !== options.folder) {
          this.log.info(
            { original: options.folder, normalized },
            'nylas: listMessages — normalized folder alias to Gmail label ID',
          );
        }
        params.set('in', normalized);
      }
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
    attachments?: DraftAttachment[];
  }): Promise<NylasDraft> {
    const url = `${this.baseUrl}/drafts`;
    const messagePayload: Record<string, unknown> = {
      reply_to_message_id: options.replyToMessageId,
      subject: options.subject,
      body: options.body,
      to: options.to,
    };
    if (options.cc && options.cc.length > 0) {
      messagePayload.cc = options.cc;
    }
    const data = await this.requestDraft(url, 'createDraftReply', messagePayload, options.attachments);
    return {
      id: data.id,
      subject: data.subject ?? '',
      to: (data.to ?? []).map(normParticipant),
      cc: (data.cc ?? []).map(normParticipant),
    };
  }

  // Create a brand-new draft (cold compose, no reply thread).
  // Unlike createDraftReply, this omits reply_to_message_id so the draft
  // lands in the CEO's Drafts folder as a fresh outbound email.
  async createDraft(options: {
    subject: string;
    body: string;
    to: NylasParticipant[];
    cc?: NylasParticipant[];
    attachments?: DraftAttachment[];
  }): Promise<NylasDraft> {
    const url = `${this.baseUrl}/drafts`;
    const messagePayload: Record<string, unknown> = {
      subject: options.subject,
      body: options.body,
      to: options.to,
    };
    if (options.cc && options.cc.length > 0) {
      messagePayload.cc = options.cc;
    }
    const data = await this.requestDraft(url, 'createDraft', messagePayload, options.attachments);
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

  /**
   * POST a draft creation request to the Nylas REST API.
   *
   * When `attachments` is absent or empty, sends a plain JSON body (same as before).
   * When attachments are present, switches to multipart/form-data:
   *   - Part "message": JSON string of the draft metadata
   *   - Parts "file0", "file1", …: binary attachment content
   *
   * Nylas v3 REST requires multipart for any draft that includes file attachments.
   * The Node.js global `FormData` (available since Node 18) handles boundary encoding.
   * We intentionally omit the Content-Type header when using FormData so that fetch
   * can set it automatically with the correct multipart boundary.
   */
  private async requestDraft(
    url: string,
    operation: string,
    messagePayload: Record<string, unknown>,
    attachments?: DraftAttachment[],
  ): Promise<NylasApiDraft> {
    if (!attachments || attachments.length === 0) {
      return this.request<NylasApiDraft>('POST', url, operation, messagePayload);
    }

    this.log.debug({ operation, attachmentCount: attachments.length }, `nylas: ${operation} (multipart)`);

    const form = new FormData();
    form.append('message', new Blob([JSON.stringify(messagePayload)], { type: 'application/json' }));
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      form.append(`file${i}`, new Blob([att.content], { type: att.contentType }), att.filename);
    }

    // Omit Content-Type — fetch sets it automatically with the multipart boundary.
    const { 'Content-Type': _ct, ...headersWithoutContentType } = this.headers;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: headersWithoutContentType, body: form });
    } catch (err) {
      this.log.error({ err, operation }, `nylas: ${operation} fetch failed`);
      throw new NylasApiError(0, operation, `Fetch failed: ${String(err)}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '(unreadable body)');
      this.log.error({ status: res.status, operation }, `nylas: ${operation} API error`);
      throw new NylasApiError(res.status, operation, `Nylas ${operation}: HTTP ${res.status} — ${text}`);
    }

    const json = (await res.json()) as { data: NylasApiDraft };
    return json.data;
  }

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
    // Nylas v3 list responses include to and cc. Expose them in the summary so
    // Sent-folder sweeps can collect recipient addresses without per-message reads.
    to: (msg.to ?? []).map(normParticipant),
    cc: (msg.cc ?? []).map(normParticipant),
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
    // to and cc come from normalizeMessageSummary; only bcc is full-message-only.
    bcc: (msg.bcc ?? []).map(normParticipant),
    body: msg.body ?? '',
    labels: msg.labels ?? msg.folders ?? [],
  };
}

// ── HTML → plain text utility ───────────────────────────────────────────────

export function htmlToPlainText(html: string | undefined | null): string {
  if (!html) return '';
  // First convert block-level tags to newlines (single-pass, not security-sensitive).
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');

  // Strip <script> and <style> blocks including their content. Loop until the
  // string stops changing to prevent nested-substitution bypass (e.g.
  // <scri<script>pt>…<scri<script>pt> leaves outer fragments that merge into
  // <script>…</script> after one pass; a second pass catches those).
  // [^>]* before the closing > handles padded tags like </script > and also
  // closing tags with unexpected attributes like </script foo> that \s* misses.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '');
  }

  // Strip all remaining HTML tags. Loop until stable — stripping a complete tag
  // can expose an incomplete <tagname fragment from a nested structure, and
  // stripping an incomplete fragment can in turn expose a new complete tag.
  // {0,500} caps the incomplete-tag pattern to prevent consuming large bodies
  // on inputs with a lone < far from any >.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^>]+>/g, ''); // complete tags
    text = text.replace(/<[a-zA-Z][^>]{0,500}/g, ''); // incomplete tags
  }

  // Decode HTML entities.
  // Order matters: &amp; must be decoded LAST to prevent double-decoding.
  // Decoding &amp; first would turn &amp;lt; into &lt; and then into <,
  // smuggling a literal < into the output.
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
