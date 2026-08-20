//
// Wire types + codec for signal-cli voice-call JSON-RPC (curia#1672).
//
// callId is a signed 64-bit value that routinely exceeds Number.MAX_SAFE_INTEGER
// (observed live: -7828393543136742976). JSON.parse would silently round it and
// acceptCall would then target a nonexistent call, so raw socket lines are
// pre-processed with quoteCallIds() before parsing, and outbound params are
// serialized by string construction so the wire carries a bare number literal
// (signal-cli's Jackson side reads numeric types, not strings).

export type SignalCallState =
  | 'RINGING_INCOMING'
  | 'RINGING_OUTGOING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'ENDED';

const CALL_STATES: ReadonlySet<string> = new Set([
  'RINGING_INCOMING',
  'RINGING_OUTGOING',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'ENDED',
]);

export interface SignalCallEvent {
  callId: bigint;
  state: SignalCallState;
  /** Caller's E.164 number; may be absent when only the ACI uuid is known. */
  number: string | null;
  /** Caller's Signal ACI uuid. */
  uuid: string | null;
  isOutgoing: boolean;
  inputDeviceName: string | null;
  outputDeviceName: string | null;
  /** Present on ENDED (e.g. 'RemoteHangup'). */
  reason: string | null;
}

/**
 * Quote every bare-number "callId" value in a raw JSON line so JSON.parse
 * preserves full 64-bit precision (the value is re-read as a string).
 * Idempotent: already-quoted values don't match the bare-number pattern.
 */
export function quoteCallIds(line: string): string {
  return line.replace(/"callId"\s*:\s*(-?\d+)/g, '"callId":"$1"');
}

/** Parse the `result` object of a quoteCallIds-preprocessed callEvent notification. */
export function parseSignalCallEvent(result: Record<string, unknown>): SignalCallEvent | null {
  const rawId = result.callId;
  if (typeof rawId !== 'string' || !/^-?\d+$/.test(rawId)) return null;
  const state = result.state;
  if (typeof state !== 'string' || !CALL_STATES.has(state)) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    callId: BigInt(rawId),
    state: state as SignalCallState,
    number: str(result.number),
    uuid: str(result.uuid),
    isOutgoing: result.isOutgoing === true,
    inputDeviceName: str(result.inputDeviceName),
    outputDeviceName: str(result.outputDeviceName),
    reason: str(result.reason),
  };
}

/**
 * Build the params JSON text for acceptCall/rejectCall/hangupCall by string
 * construction — JSON.stringify throws on bigint, and stringifying via Number
 * would corrupt the id. account is JSON-escaped via stringify.
 */
export function serializeCallParams(account: string, callId: bigint): string {
  return `{"account":${JSON.stringify(account)},"callId":${callId.toString()}}`;
}
