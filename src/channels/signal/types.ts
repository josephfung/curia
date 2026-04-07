// src/channels/signal/types.ts
//
// TypeScript types for the signal-cli JSON-RPC wire format.
//
// signal-cli exposes a JSON-RPC 2.0 interface over a Unix socket (or TCP).
// These types cover the subset of the wire format that Curia actually uses:
//   - Inbound: receive notifications (text messages, group messages)
//   - Outbound: send requests, read receipt requests
//
// Ignored envelope types (not modelled here because we drop them):
//   - callMessage — voice/video call events
//   - typingMessage — typing indicators
//   - receiptMessage — delivery/read receipt confirmations from Signal peers
//
// signal-cli JSON-RPC docs:
//   https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service

// ---------------------------------------------------------------------------
// Inbound — envelope types
// ---------------------------------------------------------------------------

/**
 * Top-level envelope wrapping every event that signal-cli delivers to us.
 * Exactly one of {dataMessage, syncMessage} will be set for messages we care
 * about; the rest will be null or absent.
 */
export interface SignalEnvelope {
  /** Sender's E.164 phone number, e.g. "+14155552671" */
  source: string;
  /** Same as source — signal-cli includes both fields */
  sourceNumber: string;
  /** Signal's internal UUID for the sender's account */
  sourceUuid: string;
  /** Display name from Signal's profile (may be empty string) */
  sourceName: string;
  /** Device number (1 = primary device) */
  sourceDevice: number;
  /**
   * Signal-level timestamp in milliseconds. This is NOT a Unix wall-clock time —
   * it's Signal's own message identifier. Required for read receipts: the Signal
   * protocol uses targetTimestamp to identify which specific message was read.
   */
  timestamp: number;
  /** Set for regular inbound messages from other Signal users */
  dataMessage?: SignalDataMessage;
  /** Set for messages sent from Curia's own other devices (self-sync) */
  syncMessage?: SignalSyncMessage;
}

/**
 * The payload of a regular inbound message.
 * `message` is null for reaction-only messages, view-once after viewing, etc.
 */
export interface SignalDataMessage {
  /** Signal-level timestamp (ms) — matches envelope.timestamp for sender-originated messages */
  timestamp: number;
  /** Message text content. Null for reactions, attachment-only messages, etc. */
  message: string | null;
  /** Expiry timer in seconds (0 = no expiry) */
  expiresInSeconds: number;
  /** View-once messages self-destruct after being read — we skip these entirely */
  viewOnce: boolean;
  /** Present when the message was sent to a group rather than a direct chat */
  groupInfo?: SignalGroupInfo;
  /** File/image attachments. signal-cli saves these to a local directory. */
  attachments?: SignalAttachment[];
  /** Present when this is an emoji reaction, not a text message */
  reaction?: SignalReaction;
}

/**
 * Group context attached to messages sent in a Signal group chat.
 * Only `type: 'DELIVER'` means "this is a real message" — UPDATE, QUIT, and
 * UNKNOWN are group management events with no displayable content.
 */
export interface SignalGroupInfo {
  /** Base64-encoded group V2 ID — stable identifier for the group conversation */
  groupId: string;
  type: 'DELIVER' | 'UPDATE' | 'QUIT' | 'UNKNOWN';
}

/** Metadata for an inbound attachment. The file itself is saved by signal-cli. */
export interface SignalAttachment {
  /** signal-cli internal attachment ID (filename in the attachments directory) */
  id: string;
  contentType: string;
  filename?: string;
  size: number;
}

/** An emoji reaction to a previous message. We ignore these per spec (MVP). */
export interface SignalReaction {
  emoji: string;
  /** E.164 number of the message author being reacted to */
  targetAuthor: string;
  /** Signal timestamp of the target message */
  targetTimestamp: number;
  /** True = removing a previous reaction */
  isRemove: boolean;
}

/**
 * Messages Curia sends from another Signal device (phone, desktop) are
 * mirrored back to all linked devices as syncMessage envelopes. We discard
 * these — they represent Curia's outbound activity, not inbound requests.
 */
export interface SignalSyncMessage {
  sentMessage?: {
    message: string;
    destination?: string;
    groupInfo?: SignalGroupInfo;
  };
}

/**
 * The `params` field of a `receive` JSON-RPC notification from signal-cli.
 * This is the top-level payload for every inbound envelope.
 */
export interface SignalReceiveParams {
  envelope: SignalEnvelope;
  /** Curia's registered phone number — the account that received the message */
  account: string;
}

// ---------------------------------------------------------------------------
// Outbound — request param types
// ---------------------------------------------------------------------------

/**
 * Params for the signal-cli `send` JSON-RPC method.
 * Either `recipient` (1:1) or `groupId` (group) must be set, not both.
 */
export interface SignalSendParams {
  /** Curia's registered phone number — the sending account */
  account: string;
  /** E.164 number array for 1:1 sends. signal-cli takes an array. */
  recipient?: string[];
  /** Base64 group ID for group sends */
  groupId?: string;
  message: string;
}

/**
 * Params for the signal-cli `sendReceipt` JSON-RPC method.
 * Used to send read receipts back to known senders for 1:1 messages.
 *
 * Note: read receipts are 1:1 only — group receipt semantics are more complex
 * (they broadcast to all group members). Group read receipts are deferred.
 */
export interface SignalReadReceiptParams {
  /** Curia's registered phone number — the account sending the receipt */
  account: string;
  /** The sender who will receive the read confirmation */
  recipient: string;
  /**
   * Signal timestamps of the messages being acknowledged.
   * Must match the `timestamp` field from the original envelope exactly —
   * Signal uses this to identify which specific messages were read.
   */
  targetTimestamp: number[];
  receiptType: 'read' | 'viewed';
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types
// ---------------------------------------------------------------------------

/** A JSON-RPC request that we send to signal-cli */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** A JSON-RPC success response from signal-cli */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
}

/** A JSON-RPC error response from signal-cli */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * A JSON-RPC notification (server-initiated, no `id` field).
 * signal-cli sends these for inbound messages via the `receive` method.
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export type JsonRpcMessage =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;
