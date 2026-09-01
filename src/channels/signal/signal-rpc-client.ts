// src/channels/signal/signal-rpc-client.ts
//
// JSON-RPC 2.0 client for the signal-cli daemon.
//
// signal-cli runs as a separate service and exposes a Unix socket (or TCP port).
// This client connects to that socket, sends requests, and listens for inbound
// message notifications.
//
// Wire protocol:
//   - Newline-delimited JSON (one JSON object per line, terminated by '\n')
//   - Requests:      { jsonrpc: "2.0", id: "req-N", method: "...", params: {...} }
//   - Responses:     { jsonrpc: "2.0", id: "req-N", result: {...} }
//                    { jsonrpc: "2.0", id: "req-N", error: {...} }
//   - Notifications: { jsonrpc: "2.0", method: "receive", params: { envelope: {...} } }
//                    (no `id` field — server-initiated, no response expected)
//
// Reconnect strategy:
//   Exponential backoff starting at 1s, doubling each attempt, capped at 5 minutes.
//   Reset to 1s on successful connect.
//   Pending requests are rejected immediately on disconnect (connection error),
//   so callers don't hang waiting for a response that will never arrive.
//
// Deduplication:
//   signal-cli may re-deliver the most recent messages after a reconnect in some
//   versions. We deduplicate by `${sourceNumber}:${timestamp}` using a sliding
//   window Set (max 1000 entries) so re-delivered envelopes are silently dropped.

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../../logger.js';
import type {
  SignalSendParams,
  SignalReadReceiptParams,
  JsonRpcMessage,
  SignalReceiveParams,
  SignalGroupDetails,
} from './types.js';
import { parseSignalCallEvent, quoteCallIds, serializeCallParams } from './call-types.js';

export interface SignalRpcClientConfig {
  /** Path to the signal-cli Unix socket, e.g. '/run/signal-cli/socket' */
  socketPath: string;
  /** The agent's phone number — sent as the `account` param in all RPC calls */
  accountNumber: string;
  logger: Logger;
}

// Backoff config — tuned for a local socket where the partner service may be
// briefly unavailable during a container restart or config reload.
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 300_000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10_000;

// Dedup window — sized to cover all messages that could arrive in a short burst
// after reconnect. 1000 is generous; Signal conversations are not that bursty.
const DEDUP_MAX_SIZE = 1_000;

export class SignalRpcClient extends EventEmitter {
  private readonly config: SignalRpcClientConfig;
  private readonly log: Logger;

  private socket: net.Socket | null = null;
  private buffer = '';
  // StringDecoder handles multibyte characters (e.g. emoji, CJK) that may be
  // split across TCP/socket chunk boundaries. chunk.toString('utf8') would corrupt
  // a character whose bytes span two chunks; StringDecoder buffers the incomplete
  // bytes internally and emits only complete characters.
  private readonly decoder = new StringDecoder('utf8');
  private requestCounter = 0;
  // Map of pending request IDs → { resolve, reject, timeoutHandle }
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();

  // Deduplication: set of "sourceNumber:timestamp" strings we've already processed.
  // Insertion-order array serves as an eviction queue so we can drop the oldest entry
  // when the set grows beyond DEDUP_MAX_SIZE.
  private readonly dedupSet = new Set<string>();
  private readonly dedupQueue: string[] = [];

  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  /** True while the Unix socket is open (#1380 outbound queue). */
  private connected = false;
  /**
   * True once a caller has asked for voice-call events. The subscription
   * dies with the socket, so this flag drives a resubscribe on every
   * reconnect — see setCallEventsSubscription() (#1672).
   */
  private callEventsWanted = false;

  constructor(config: SignalRpcClientConfig) {
    super();
    this.config = config;
    this.log = config.logger.child({ component: 'signal-rpc-client' });
  }

  /**
   * Whether the signal-cli Unix socket is currently open.
   * Used by OutboundGateway to enqueue instead of dropping when down (#1380).
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the Signal RPC client. Resolves immediately — does NOT wait for the
   * socket connection to succeed.
   *
   * Rationale: In Docker Compose, signal-cli and Curia start concurrently, so
   * the socket may not be available on the first attempt. Rejecting `connect()`
   * on the first failure would propagate to `SignalAdapter.start()`, then to
   * `index.ts`, and crash the process — even though the reconnect loop would
   * have eventually recovered. Instead, we start the reconnect loop and let it
   * make the connection in the background. The 'connected' event signals when
   * the socket is ready; inbound messages flow from that point.
   *
   * If you need to know when the first successful connection happens, listen
   * for the 'connected' event.
   */
  connect(): void {
    this.stopping = false;
    // Start the first attempt but don't await it. If it fails, the 'close' event
    // handler calls scheduleReconnect(), which will keep retrying with backoff.
    void this.attemptConnect();
  }

  /**
   * Gracefully disconnect and stop reconnecting.
   * All pending requests are rejected with a "disconnecting" error.
   */
  async disconnect(): Promise<void> {
    this.stopping = true;

    // Cancel any queued reconnect attempt
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject pending requests so callers don't hang
    this.rejectAllPending(new Error('Signal RPC client disconnecting'));

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.log.info('Signal RPC client disconnected');
  }

  // ---------------------------------------------------------------------------
  // Outbound RPC calls
  // ---------------------------------------------------------------------------

  /**
   * Send a text message via signal-cli.
   * Resolves with the sent message's Signal timestamp (stringified) — the
   * provider message id used for reaction correlation (#1479).
   * Rejects on error or timeout.
   */
  async send(params: SignalSendParams): Promise<string> {
    const result = await this.call('send', params as unknown as Record<string, unknown>);
    const timestamp = extractSendTimestamp(result);
    if (timestamp === undefined) {
      throw new Error('signal-cli send: response missing timestamp');
    }
    return timestamp;
  }

  /**
   * Send a read receipt to a specific sender for one or more messages.
   * Fire-and-forget at the caller level — errors are logged but don't propagate
   * to the inbound processing pipeline.
   */
  async sendReadReceipt(params: SignalReadReceiptParams): Promise<void> {
    await this.call('sendReceipt', params as unknown as Record<string, unknown>);
  }

  /**
   * List all Signal groups the account is currently a member of.
   * Returns the full membership list including phone numbers for each member.
   * Used by the group trust check to verify all members before engaging.
   */
  async listGroups(): Promise<SignalGroupDetails[]> {
    const result = await this.call('listGroups', { account: this.config.accountNumber });
    if (!Array.isArray(result)) {
      throw new Error('listGroups: unexpected response shape from signal-cli — expected array');
    }
    return result as SignalGroupDetails[];
  }

  /**
   * Fetch a previously-downloaded attachment's raw bytes via signal-cli `getAttachment`.
   * The JSON-RPC result is base64 (`{ data }` or a raw string). Used for inbound
   * voice-note transcription (#1600).
   *
   * `recipient` (1:1 sender) or `groupId` must be set — signal-cli requires one.
   *
   * Callers must reject oversized attachments **before** invoking this: the result
   * is a single JSON-RPC line accumulated in `handleData`, and this method rides
   * the shared `REQUEST_TIMEOUT_MS` (10s) budget — fine for a local-socket disk
   * read of a few MB, not for a 100 MB Signal attachment.
   */
  async getAttachment(opts: {
    id: string;
    recipient?: string;
    groupId?: string;
  }): Promise<Uint8Array> {
    const params: Record<string, unknown> = {
      account: this.config.accountNumber,
      id: opts.id,
    };
    if (opts.groupId) {
      params.groupId = opts.groupId;
    } else if (opts.recipient) {
      params.recipient = opts.recipient;
    }
    const result = await this.call('getAttachment', params);
    return decodeSignalAttachmentResult(result);
  }

  /**
   * Enable (or disable) voice-call event delivery. When enabled, the client
   * sends `subscribeCallEvents` now (if connected) and after every reconnect —
   * signal-cli silently ignores incoming calls unless a live subscription exists,
   * and the subscription dies with the socket (#1672).
   */
  setCallEventsSubscription(enabled: boolean): void {
    this.callEventsWanted = enabled;
    if (enabled && this.connected) void this.sendCallEventsSubscribe();
  }

  async acceptCall(callId: bigint): Promise<void> {
    await this.callWithRawParams('acceptCall', serializeCallParams(this.config.accountNumber, callId));
  }

  async rejectCall(callId: bigint): Promise<void> {
    await this.callWithRawParams('rejectCall', serializeCallParams(this.config.accountNumber, callId));
  }

  async hangupCall(callId: bigint): Promise<void> {
    await this.callWithRawParams('hangupCall', serializeCallParams(this.config.accountNumber, callId));
  }

  private async sendCallEventsSubscribe(): Promise<void> {
    try {
      await this.call('subscribeCallEvents', { account: this.config.accountNumber });
      this.log.info('Signal call events subscribed');
    } catch (err) {
      // Must not throw into the reconnect path; the next reconnect retries.
      this.log.error({ err }, 'Failed to subscribe to Signal call events — incoming calls will be ignored until next reconnect');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: connection management
  // ---------------------------------------------------------------------------

  private attemptConnect(): Promise<void> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      this.socket = socket;
      // Track whether the connect() promise has already settled so the 'error'
      // handler doesn't try to resolve/reject an already-settled promise.
      let settled = false;

      socket.connect(this.config.socketPath, () => {
        settled = true;
        this.connected = true;
        this.log.info({ socketPath: this.config.socketPath }, 'Signal RPC client connected');
        // Reset backoff on successful connect so the next disconnect starts fresh.
        this.backoffMs = BACKOFF_INITIAL_MS;
        this.emit('connected');
        // The call-events subscription lives on the socket, not the client —
        // it must be re-sent on every reconnect (#1672).
        if (this.callEventsWanted) void this.sendCallEventsSubscribe();
        resolve();
      });

      socket.on('data', (chunk: Buffer) => this.handleData(chunk));

      socket.on('close', () => {
        // Clear the line buffer on disconnect — any partial line buffered from the
        // previous session is invalid on the new connection and would corrupt the
        // first message received after reconnect.
        this.buffer = '';
        this.socket = null;
        this.connected = false;
        // Reject any requests that were waiting for a response — they will never
        // arrive now that the socket is gone.
        this.rejectAllPending(new Error('Signal RPC socket closed unexpectedly'));
        this.emit('disconnected');
        // Resolve the initial connect() promise if it hasn't settled yet — a
        // failed first connect still "starts" the client; reconnect takes over.
        if (!settled) {
          settled = true;
          resolve();
        }
        if (!this.stopping) {
          this.log.warn('Signal RPC socket closed — scheduling reconnect');
        }
        this.scheduleReconnect();
      });

      socket.on('error', (err: Error) => {
        // Log the error. 'close' always fires after 'error' on a net.Socket,
        // so reconnect scheduling and promise settlement both happen in the
        // 'close' handler above — no action needed here beyond logging.
        this.log.warn({ err }, 'Signal RPC socket error');
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;

    const delay = this.backoffMs;
    // Double for next attempt, capped at max. This means after 5 minutes of
    // repeated failures the retry cadence stays at 5 minutes (not infinite growth).
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);

    this.log.info({ delayMs: delay }, 'Signal RPC client will attempt reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // attemptConnect() resolves on success (we ignore the result here —
      // events do the work) or rejects on first error (the 'close' handler
      // will schedule another reconnect).
      this.attemptConnect().catch((err: unknown) => {
        // Error already logged in the socket 'error' handler. The 'close' event
        // that follows will schedule the next reconnect attempt.
        this.log.debug({ err }, 'Signal RPC reconnect attempt failed — will retry');
      });
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Private: JSON-RPC request/response
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and await the response.
   * Rejects after REQUEST_TIMEOUT_MS if no response arrives.
   */
  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.callWithRawParams(method, JSON.stringify(params));
  }

  /**
   * Like call(), but the params JSON text is supplied verbatim — required for
   * call methods whose callId must be a bare 64-bit number literal (bigint
   * breaks JSON.stringify; Number breaks precision). See call-types.ts.
   */
  private callWithRawParams(method: string, paramsJson: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Signal RPC client is not connected'));
        return;
      }

      const id = `req-${++this.requestCounter}`;

      // Timeout guard — reject if signal-cli doesn't respond within the window.
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signal RPC request timed out: ${method} (id=${id})`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });

      // Write the request as a single newline-terminated JSON line, built by
      // string construction so paramsJson (which may contain a bare bigint
      // literal) is embedded verbatim rather than re-serialized.
      const line = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${paramsJson}}\n`;
      this.socket.write(line, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Error(`Signal RPC write failed: ${err.message}`));
        }
      });
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: inbound data parsing
  // ---------------------------------------------------------------------------

  /**
   * Accumulate incoming bytes into a line buffer and process complete lines.
   * signal-cli's newline-delimited JSON means each '\n' marks the end of one message.
   */
  private handleData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    // The last element is either empty (if chunk ended with '\n') or a partial line.
    // Keep it in the buffer for the next chunk.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcMessage;
    try {
      // callId values are signed 64-bit numbers that can exceed
      // Number.MAX_SAFE_INTEGER; JSON.parse would silently round them, so
      // quote them to strings first and let call-types.ts re-parse via BigInt.
      // The includes() guard keeps the regex off the hot message-receive path.
      const raw = JSON.parse(line.includes('"callId"') ? quoteCallIds(line) : line);
      // Guard against valid JSON that isn't an object (e.g. a bare string or number).
      // signal-cli should never send these, but be defensive — 'in' throws on non-objects.
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        // Log the line length only — the raw content may contain message text (PII).
        this.log.warn({ lineLength: line.length }, 'Signal RPC: received unexpected non-object JSON line');
        return;
      }
      parsed = raw as JsonRpcMessage;
    } catch (err) {
      // Malformed JSON from signal-cli — log and skip. This could indicate a
      // protocol version mismatch or a partial write that wasn't framed correctly.
      // Log the line length only — the raw content may contain message text (PII).
      this.log.warn({ err, lineLength: line.length }, 'Signal RPC: received malformed JSON line');
      return;
    }

    // Notifications have no `id` field — they are server-initiated pushes.
    if (!('id' in parsed)) {
      this.handleNotification(parsed as { method: string; params: Record<string, unknown> });
      return;
    }

    // Response to one of our requests — correlate by id.
    const id = (parsed as { id: string }).id;
    const pending = this.pending.get(id);
    if (!pending) {
      // Response for an unknown or already-timed-out request — safe to ignore.
      this.log.debug({ id }, 'Signal RPC: received response for unknown request id');
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if ('error' in parsed && parsed.error) {
      const { code, message } = (parsed as { error: { code: number; message: string } }).error;
      pending.reject(new Error(`Signal RPC error ${code}: ${message}`));
    } else {
      pending.resolve((parsed as { result: unknown }).result);
    }
  }

  /**
   * Handle a server-initiated notification (no `id` field).
   * Notifications we care about: `receive` (inbound messages) and
   * `callEvent` (voice-call state changes, #1672). Call events do NOT go
   * through the message dedup window — they aren't messages and signal-cli
   * does not re-deliver them on reconnect the way it does for `receive`.
   */
  private handleNotification(notification: { method: string; params: Record<string, unknown> }): void {
    if (notification.method === 'callEvent') {
      const result = (notification.params as { result?: unknown })?.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        this.log.warn('Signal RPC: callEvent notification missing result object');
        return;
      }
      const ev = parseSignalCallEvent(result as Record<string, unknown>);
      if (!ev) {
        this.log.warn('Signal RPC: unparseable callEvent notification');
        return;
      }
      this.emit('callEvent', ev);
      return;
    }

    if (notification.method !== 'receive') {
      // signal-cli may send other notifications in the future (typing indicators, etc.).
      // Log at debug so we're aware but don't spam at info level.
      this.log.debug({ method: notification.method }, 'Signal RPC: ignoring non-receive notification');
      return;
    }

    const receiveParams = notification.params as unknown as SignalReceiveParams;
    const envelope = receiveParams?.envelope;

    if (!envelope) {
      // Log only structural metadata — params may contain sourceNumber and message text (PII).
      this.log.warn({ hasParams: !!notification.params }, 'Signal RPC: receive notification missing envelope');
      return;
    }

    // Deduplicate using sourceNumber + Signal timestamp.
    // signal-cli may re-deliver recent messages after a reconnect. Dropping them
    // here prevents the coordinator from seeing the same message twice.
    const dedupKey = `${envelope.sourceNumber}:${envelope.timestamp}`;
    if (this.dedupSet.has(dedupKey)) {
      this.log.debug({ dedupKey }, 'Signal RPC: dropping duplicate envelope');
      return;
    }

    // Add to dedup window; evict oldest entry if we're at capacity.
    // The queue gives us O(1) eviction without iterating the set.
    this.dedupSet.add(dedupKey);
    this.dedupQueue.push(dedupKey);
    if (this.dedupQueue.length > DEDUP_MAX_SIZE) {
      const oldest = this.dedupQueue.shift();
      if (oldest) this.dedupSet.delete(oldest);
    }

    this.emit('message', envelope);
  }
}

/**
 * Decode signal-cli `getAttachment` JSON-RPC result into raw bytes.
 * Exported for unit tests.
 */
export function decodeSignalAttachmentResult(result: unknown): Uint8Array {
  let encoded: string | undefined;
  if (typeof result === 'string') {
    encoded = result;
  } else if (result && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.data === 'string') encoded = obj.data;
    else if (typeof obj.dataBase64 === 'string') encoded = obj.dataBase64;
  }
  if (!encoded?.trim()) {
    throw new Error('signal-cli getAttachment: response missing attachment data');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('signal-cli getAttachment: decoded attachment is empty');
  }
  return new Uint8Array(bytes);
}

/**
 * Extract the Signal send timestamp from a signal-cli `send` JSON-RPC result.
 * The timestamp is the provider message id used for reaction correlation (#1479).
 * Exported for unit tests.
 */
export function extractSendTimestamp(result: unknown): string | undefined {
  if (typeof result === 'number' && Number.isFinite(result)) {
    return String(result);
  }
  if (typeof result === 'string' && result.trim() && Number.isFinite(Number(result))) {
    return result.trim();
  }
  if (result && typeof result === 'object') {
    const ts = (result as { timestamp?: unknown }).timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) return String(ts);
    if (typeof ts === 'string' && ts.trim() && Number.isFinite(Number(ts))) return ts.trim();
  }
  return undefined;
}
