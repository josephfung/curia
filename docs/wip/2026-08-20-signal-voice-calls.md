# Signal Voice Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can Signal-call Curia's number and hold a live spoken conversation through the existing VoiceRuntime/Deepgram/Cartesia pipeline (curia#1672).

**Architecture:** signal-cli (≥0.14.7) answers calls via its `signal-call-tunnel` subprocess and exposes call control over the existing JSON-RPC unix socket; call audio appears as per-call PulseAudio virtual devices. We add call methods + `callEvent` handling to `SignalRpcClient`, a `SignalAudioTransport` that moves 48 kHz mono PCM through `parec`/`pacat` subprocesses against a shared Pulse socket, and a `SignalCallBridge` that owns answer policy (v1: answer everyone), session lifecycle, busy handling, and a max-duration cap. `VoiceRuntime` gains a per-session transport override; everything else (STT/TTS/turn loop/barge-in/greeting) is reused unchanged.

**Tech Stack:** TypeScript ESM (Node 24), vitest, pino, existing `AudioTransport` seam, PulseAudio CLI tools (`parec`/`pacat`) at runtime only (never in CI).

**Spec:** `docs/wip/2026-08-20-signal-voice-calls-design.md` (same branch). The deploy-side work (curia-deploy: signal-cli 0.14.7 image + tunnel build + Pulse socket volume) is a separate repo/PR and is NOT part of this plan.

## Global Constraints

- ESM only: `.js` extensions on all relative imports; no `any`; pino logging (no `console.log`); no empty catch blocks.
- `callId` is a signed 64-bit value that exceeds `Number.MAX_SAFE_INTEGER` (spike observed `-7828393543136742976`). It MUST be `bigint` end-to-end; never `Number(callId)`, never plain `JSON.parse`/`JSON.stringify` on messages containing it.
- PCM format everywhere in this feature: 48 000 Hz, mono, s16le. One frame = 20 ms = 960 samples = 1920 bytes.
- Feature is dark by default: `SIGNAL_VOICE_CALLS_ENABLED` must gate every new runtime behavior.
- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls`. Run tests as `pnpm -C <worktree> exec vitest run <file>` and typecheck as `pnpm -C <worktree> run typecheck` (use `-C`, never `--prefix`). Typecheck before every commit. All commits: conventional style, `-s` sign-off, no Claude credits.

---

### Task 1: Call wire types + bigint-safe callId codec

**Files:**
- Create: `src/channels/signal/call-types.ts`
- Modify: `src/channels/signal/types.ts:10-13` (header comment only — callMessage is no longer ignored)
- Test: `src/channels/signal/call-types.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type SignalCallState = 'RINGING_INCOMING' | 'RINGING_OUTGOING' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ENDED'`
  - `interface SignalCallEvent { callId: bigint; state: SignalCallState; number: string | null; uuid: string | null; isOutgoing: boolean; inputDeviceName: string | null; outputDeviceName: string | null; reason: string | null }`
  - `function quoteCallIds(line: string): string`
  - `function parseSignalCallEvent(result: Record<string, unknown>): SignalCallEvent | null`
  - `function serializeCallParams(account: string, callId: bigint): string` → the exact JSON object text `{"account":"+1...","callId":-78283...}` with callId as a bare number literal.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/channels/signal/call-types.test.ts
import { describe, expect, it } from 'vitest';
import { parseSignalCallEvent, quoteCallIds, serializeCallParams } from './call-types.js';

describe('quoteCallIds', () => {
  it('quotes a callId larger than MAX_SAFE_INTEGER so JSON.parse cannot corrupt it', () => {
    const line = '{"method":"callEvent","params":{"result":{"callId":-7828393543136742976,"state":"RINGING_INCOMING"}}}';
    const quoted = quoteCallIds(line);
    const parsed = JSON.parse(quoted) as { params: { result: { callId: string } } };
    expect(parsed.params.result.callId).toBe('-7828393543136742976');
  });

  it('leaves lines without callId untouched', () => {
    const line = '{"method":"receive","params":{"envelope":{"timestamp":1755700000000}}}';
    expect(quoteCallIds(line)).toBe(line);
  });

  it('quotes positive callIds too', () => {
    const quoted = quoteCallIds('{"callId":10618350530572808640}');
    expect(JSON.parse(quoted)).toEqual({ callId: '10618350530572808640' });
  });

  it('does not touch an already-quoted callId', () => {
    const line = '{"callId":"123"}';
    expect(quoteCallIds(line)).toBe(line);
  });
});

describe('parseSignalCallEvent', () => {
  it('parses a full RINGING_INCOMING event with bigint callId', () => {
    const ev = parseSignalCallEvent({
      callId: '-7828393543136742976',
      state: 'RINGING_INCOMING',
      number: '+15196161377',
      uuid: '93d5da7e-b744-4189-9f99-463fe46c7f71',
      isOutgoing: false,
      inputDeviceName: 'signal_input_10618350530572808640',
      outputDeviceName: 'signal_output_10618350530572808640',
    });
    expect(ev).not.toBeNull();
    expect(ev!.callId).toBe(-7828393543136742976n);
    expect(ev!.state).toBe('RINGING_INCOMING');
    expect(ev!.number).toBe('+15196161377');
    expect(ev!.inputDeviceName).toBe('signal_input_10618350530572808640');
    expect(ev!.reason).toBeNull();
  });

  it('parses ENDED with reason and null device names absent', () => {
    const ev = parseSignalCallEvent({ callId: '5', state: 'ENDED', isOutgoing: false, reason: 'RemoteHangup' });
    expect(ev!.state).toBe('ENDED');
    expect(ev!.reason).toBe('RemoteHangup');
    expect(ev!.number).toBeNull();
  });

  it('returns null for an unknown state or missing callId', () => {
    expect(parseSignalCallEvent({ callId: '5', state: 'DIALING', isOutgoing: false })).toBeNull();
    expect(parseSignalCallEvent({ state: 'ENDED', isOutgoing: false })).toBeNull();
  });
});

describe('serializeCallParams', () => {
  it('emits callId as a bare JSON number literal beyond MAX_SAFE_INTEGER', () => {
    expect(serializeCallParams('+12264448150', -7828393543136742976n)).toBe(
      '{"account":"+12264448150","callId":-7828393543136742976}',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/signal/call-types.test.ts`
Expected: FAIL — `Cannot find module './call-types.js'`

- [ ] **Step 3: Implement `call-types.ts`**

```typescript
// src/channels/signal/call-types.ts
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
```

Also update the header comment in `src/channels/signal/types.ts` (lines 10-13): remove `callMessage` from the "ignored envelope types" list and add a pointer line: `// Voice-call control (callEvent notifications) lives in call-types.ts (#1672).`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/signal/call-types.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/signal/call-types.ts src/channels/signal/call-types.test.ts src/channels/signal/types.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(signal): call wire types + bigint-safe callId codec (#1672)"
```

---

### Task 2: SignalRpcClient call methods + callEvent emission

**Files:**
- Modify: `src/channels/signal/signal-rpc-client.ts` (imports; `attemptConnect` connected-handler at :207-215; `handleLine` at :342; `handleNotification` at :392-428; new public methods after `listGroups` at :193)
- Test: `src/channels/signal/signal-rpc-client-calls.test.ts` (new file; leave the existing client tests untouched)

**Interfaces:**
- Consumes: `quoteCallIds`, `parseSignalCallEvent`, `serializeCallParams`, `SignalCallEvent` from `./call-types.js` (Task 1).
- Produces (on `SignalRpcClient`):
  - `setCallEventsSubscription(enabled: boolean): void` — when enabled, the client sends `subscribeCallEvents` immediately (if connected) and again after EVERY reconnect. This lives inside the client because the subscription dies with the socket; leaving it to callers recreates the silent-ignore trap.
  - `acceptCall(callId: bigint): Promise<void>`, `rejectCall(callId: bigint): Promise<void>`, `hangupCall(callId: bigint): Promise<void>`
  - Event: `client.on('callEvent', (ev: SignalCallEvent) => ...)`

**Implementation notes (exact):**
- In `handleLine`, change the parse line `const raw = JSON.parse(line);` to `const raw = JSON.parse(line.includes('"callId"') ? quoteCallIds(line) : line);` — the `includes` guard keeps the regex off the hot message path.
- In `handleNotification`, before the existing `!== 'receive'` early-return, add a `callEvent` branch: extract `notification.params.result` as `Record<string, unknown>`, run `parseSignalCallEvent`, warn-log and return on null, else `this.emit('callEvent', ev)`. Call events do NOT go through the message dedup window.
- Call methods cannot reuse `private call()` (it JSON.stringifies params and bigint throws). Add a private `callWithRawParams(method: string, paramsJson: string): Promise<unknown>` that duplicates the pending-map/timeout logic of `call()` but builds the line as `` `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${paramsJson}}\n` ``. Then each public method is one line: `await this.callWithRawParams('acceptCall', serializeCallParams(this.config.accountNumber, callId));` — refactor `call()` to delegate to `callWithRawParams(method, JSON.stringify(params))` so the pending/timeout logic exists once.
- `setCallEventsSubscription(true)` sets a private `callEventsWanted = true`, and if `this.connected`, fires `void this.sendSubscribe()`. In the `socket.connect` success callback (line :213, right after `this.emit('connected')`), add: `if (this.callEventsWanted) void this.sendSubscribe();`. `sendSubscribe()` calls `this.call('subscribeCallEvents', { account: this.config.accountNumber })`, logs success at info and failure at error (never throws — a failed subscribe after reconnect must not crash the reconnect path).

- [ ] **Step 1: Write the failing tests**

Use a real `net.Server` on a temp unix socket path (pattern: `mkdtempSync(join(tmpdir(), 'sigrpc-'))`), capturing lines the client writes and pushing notification lines to it. Test cases:

```typescript
// src/channels/signal/signal-rpc-client-calls.test.ts
import { mkdtempSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignalRpcClient } from './signal-rpc-client.js';
import type { SignalCallEvent } from './call-types.js';
import { makeTestLogger } from '../../test-helpers/logger.js';
// NOTE: check src/ for the existing logger test helper used by signal-rpc-client
// or voice tests (grep "logger" in an existing *.test.ts beside these files) and
// reuse that exact import instead if it differs.

const ACCOUNT = '+12264448150';

function listen(socketPath: string, onLine: (line: string, sock: net.Socket) => void): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(sock => {
      let buf = '';
      sock.on('data', chunk => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l, sock);
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

describe('SignalRpcClient call support', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let client: SignalRpcClient;
  const received: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigrpc-'));
    socketPath = join(dir, 'socket');
    received.length = 0;
  });

  afterEach(async () => {
    await client.disconnect();
    server.close();
  });

  it('sends subscribeCallEvents on connect when enabled, and resubscribes after reconnect', async () => {
    const sockets: net.Socket[] = [];
    server = await listen(socketPath, (line, sock) => {
      received.push(line);
      if (!sockets.includes(sock)) sockets.push(sock);
      const req = JSON.parse(line) as { id: string; method: string };
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 7 }) + '\n');
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: makeTestLogger() });
    client.setCallEventsSubscription(true);
    client.connect();
    await new Promise<void>(r => client.once('connected', () => r()));
    await vi.waitFor(() => expect(received.some(l => l.includes('subscribeCallEvents'))).toBe(true));

    // Drop the connection; client reconnects (1s backoff) and must resubscribe.
    received.length = 0;
    sockets[0]!.destroy();
    await vi.waitFor(
      () => expect(received.some(l => l.includes('subscribeCallEvents'))).toBe(true),
      { timeout: 5_000 },
    );
  });

  it('emits callEvent with full-precision bigint callId', async () => {
    server = await listen(socketPath, (line, sock) => {
      const req = JSON.parse(line) as { id?: string };
      if (req.id) sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 1 }) + '\n');
      // After the subscribe request, push a callEvent notification.
      sock.write(
        '{"jsonrpc":"2.0","method":"callEvent","params":{"subscription":1,"result":'
        + '{"callId":-7828393543136742976,"state":"RINGING_INCOMING","number":"+15196161377",'
        + '"isOutgoing":false,"inputDeviceName":"signal_input_x","outputDeviceName":"signal_output_x"}}}\n',
      );
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: makeTestLogger() });
    client.setCallEventsSubscription(true);
    client.connect();
    const ev = await new Promise<SignalCallEvent>(r => client.once('callEvent', r));
    expect(ev.callId).toBe(-7828393543136742976n);
    expect(ev.state).toBe('RINGING_INCOMING');
    expect(ev.number).toBe('+15196161377');
  });

  it('acceptCall writes callId as a bare number literal with full precision', async () => {
    server = await listen(socketPath, (line, sock) => {
      received.push(line);
      const req = JSON.parse(line) as { id: string };
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n');
    });
    client = new SignalRpcClient({ socketPath, accountNumber: ACCOUNT, logger: makeTestLogger() });
    client.connect();
    await new Promise<void>(r => client.once('connected', () => r()));
    await client.acceptCall(-7828393543136742976n);
    const line = received.find(l => l.includes('acceptCall'))!;
    expect(line).toContain('"callId":-7828393543136742976');
    expect(line).toContain(`"account":"${ACCOUNT}"`);
  });
});
```

(Add the missing `import { vi } from 'vitest'` alongside the other vitest imports; if no shared `makeTestLogger` helper exists, follow whatever logger construction the existing `signal-rpc-client` or `voice-runtime` tests use — grep before inventing one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/signal/signal-rpc-client-calls.test.ts`
Expected: FAIL — `setCallEventsSubscription is not a function`

- [ ] **Step 3: Implement (per Implementation notes above)**

Concrete additions to `signal-rpc-client.ts`:

```typescript
// imports
import { parseSignalCallEvent, quoteCallIds, serializeCallParams } from './call-types.js';

// fields (near `private stopping = false;`)
private callEventsWanted = false;

// public methods (after listGroups)
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
```

`call()` refactor + `callWithRawParams` (replace the body of `call()`):

```typescript
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
    const timeout = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`Signal RPC request timed out: ${method} (id=${id})`));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(id, { resolve, reject, timeout });
    const line = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${paramsJson}}\n`;
    this.socket.write(line, err => {
      if (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Signal RPC write failed: ${err.message}`));
      }
    });
  });
}
```

`handleLine` parse-line change and `handleNotification` branch:

```typescript
// in handleLine:
const raw = JSON.parse(line.includes('"callId"') ? quoteCallIds(line) : line);

// in handleNotification, ABOVE the `!== 'receive'` check:
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
```

And in the `socket.connect(...)` success callback (after `this.emit('connected');` at :213): `if (this.callEventsWanted) void this.sendCallEventsSubscribe();`

- [ ] **Step 4: Run the new tests AND the existing client tests**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/signal/`
Expected: PASS (no regressions in existing signal tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/signal/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(signal): RPC call methods, callEvent emission, auto-resubscribe (#1672)"
```

---

### Task 3: SignalAudioTransport (PCM over parec/pacat)

**Files:**
- Create: `src/channels/voice/signal/signal-audio-transport.ts`
- Test: `src/channels/voice/signal/signal-audio-transport.test.ts`

**Interfaces:**
- Consumes: `AudioTransport`, `AudioTransportCloseReason` from `../audio-transport.js`; `PcmFrame` from `../../../speech/index.js`.
- Produces:

```typescript
export interface SignalAudioTransportOpts {
  /** PulseAudio native socket path shared from the signal-cli container. */
  pulseServer: string;
  /** From callEvent: e.g. 'signal_input_106...' — we PLAY into sink_for_<this>. */
  inputDeviceName: string;
  /** From callEvent: e.g. 'signal_output_106...' — we RECORD <this>.monitor. */
  outputDeviceName: string;
  logger: Logger;
  /** Injected for tests; defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
}
export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => AudioChildProcess;
export interface AudioChildProcess {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}
export class SignalAudioTransport implements AudioTransport {
  readonly inboundSampleRate = 48_000;
  readonly publishSampleRate = 48_000;
  constructor(opts: SignalAudioTransportOpts);
  // AudioTransport methods, plus:
  /** Bridge calls this on callEvent ENDED so the runtime tears the session down. */
  notifyRemoteHangup(): void;
}
export const SIGNAL_FRAME_SAMPLES = 960;  // 20 ms @ 48 kHz mono
```

**Behavior (exact):**
- `connect()`: spawn `parec` with args `['--server=' + pulseServer, '--device=' + outputDeviceName + '.monitor', '--rate=48000', '--channels=1', '--format=s16le', '--raw']` and `pacat` with `['--server=' + pulseServer, '--device=sink_for_' + inputDeviceName, '--rate=48000', '--channels=1', '--format=s16le', '--raw']`, env `{ ...process.env }`. Resolves once both children are spawned (no handshake — parec produces bytes when the call produces audio). Spawn `'error'` events or exit before `disconnect()` → fire close callbacks with `'transport_error'` (once).
- Inbound chunking: accumulate `parec` stdout Buffers; while ≥ 1920 bytes available, slice one 1920-byte frame, build `PcmFrame { pcm: new Int16Array(buf.buffer, buf.byteOffset, 960), sampleRate: 48000, channels: 1 }` — copy the slice first (`Buffer.from(slice)`) so the Int16Array doesn't alias the mutable accumulator; carry the remainder.
- `publishAudio(frame)`: write `Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.length * 2)` to pacat stdin; if `write()` returns false, await `'drain'` before resolving (backpressure — TTS produces faster than realtime).
- `notifyRemoteHangup()`: fire close callbacks with `'principal_disconnected'` (once; no-op after local `disconnect()`).
- `disconnect()`: set `closing = true`, SIGTERM both children, resolve after both exit or 500 ms grace (then SIGKILL). Idempotent. Never fires close callbacks (seam contract).
- Close-callback firing is guarded by a `closeFired` boolean so double-exit (parec AND pacat dying) emits once.

- [ ] **Step 1: Write the failing tests**

Build a `FakeAudioChild` (EventEmitter + PassThrough streams) in the test file:

```typescript
// src/channels/voice/signal/signal-audio-transport.test.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SignalAudioTransport } from './signal-audio-transport.js';
import type { AudioChildProcess, SpawnFn } from './signal-audio-transport.js';
// reuse the same logger helper as Task 2's test

class FakeChild extends EventEmitter implements AudioChildProcess {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    // simulate prompt exit on TERM
    queueMicrotask(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

function setup() {
  const children: { cmd: string; args: string[]; child: FakeChild }[] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    const child = new FakeChild();
    children.push({ cmd, args, child });
    return child;
  };
  const transport = new SignalAudioTransport({
    pulseServer: '/run/pulse/native',
    inputDeviceName: 'signal_input_42',
    outputDeviceName: 'signal_output_42',
    logger: makeTestLogger(),
    spawnFn,
  });
  return { transport, children };
}

describe('SignalAudioTransport', () => {
  it('spawns parec on the monitor source and pacat on the sink_for_ sink', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const parec = children.find(c => c.cmd === 'parec')!;
    const pacat = children.find(c => c.cmd === 'pacat')!;
    expect(parec.args).toContain('--device=signal_output_42.monitor');
    expect(parec.args).toContain('--server=/run/pulse/native');
    expect(pacat.args).toContain('--device=sink_for_signal_input_42');
    await transport.disconnect();
  });

  it('chunks parec stdout into 20ms 960-sample frames with remainder carry', async () => {
    const { transport, children } = setup();
    const frames: number[] = [];
    transport.onRemoteAudio(f => {
      frames.push(f.pcm.length);
      expect(f.sampleRate).toBe(48_000);
    });
    await transport.connect();
    const parec = children.find(c => c.cmd === 'parec')!.child;
    parec.stdout.write(Buffer.alloc(1920 + 1000)); // one frame + carry
    parec.stdout.write(Buffer.alloc(920));          // completes the second frame
    await vi.waitFor(() => expect(frames).toEqual([960, 960]));
    await transport.disconnect();
  });

  it('publishAudio writes s16le bytes to pacat stdin', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const pacat = children.find(c => c.cmd === 'pacat')!.child;
    const chunks: Buffer[] = [];
    pacat.stdin.on('data', (c: Buffer) => chunks.push(c));
    const pcm = new Int16Array(960).fill(1234);
    await transport.publishAudio({ pcm, sampleRate: 48_000, channels: 1 });
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBe(1920));
    expect(Buffer.concat(chunks).readInt16LE(0)).toBe(1234);
    await transport.disconnect();
  });

  it('fires onClose(transport_error) once when a child dies unexpectedly', async () => {
    const { transport, children } = setup();
    const reasons: string[] = [];
    transport.onClose(r => reasons.push(r));
    await transport.connect();
    children[0]!.child.emit('exit', 1, null);
    children[1]!.child.emit('exit', 1, null);
    expect(reasons).toEqual(['transport_error']);
  });

  it('notifyRemoteHangup fires principal_disconnected; local disconnect fires nothing', async () => {
    const { transport, children } = setup();
    const reasons: string[] = [];
    transport.onClose(r => reasons.push(r));
    await transport.connect();
    transport.notifyRemoteHangup();
    expect(reasons).toEqual(['principal_disconnected']);

    const { transport: t2 } = setup();
    const r2: string[] = [];
    t2.onClose(r => r2.push(r));
    await t2.connect();
    await t2.disconnect();
    expect(r2).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/voice/signal/signal-audio-transport.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `signal-audio-transport.ts`** per the Behavior section (all logic is specified above; default `spawnFn` wraps `spawn` from `node:child_process` passing `{ env: { ...process.env, PULSE_SERVER: opts.pulseServer } }` — pass `--server=` AND `PULSE_SERVER` so behavior is identical for the CLI tools regardless of which they honor). Every child stderr line is logged at debug via `readline`-free manual chunk splitting or just `child.stderr?.on('data', ...)` at debug level (do not let stderr accumulate unread).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run src/channels/voice/signal/signal-audio-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/voice/signal/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(voice): SignalAudioTransport — 48k PCM over parec/pacat (#1672)"
```

---

### Task 4: VoiceRuntime per-session transport override

**Files:**
- Modify: `src/channels/voice/voice-runtime.ts` (`StartVoiceSessionParams` at :351-370; `ActiveSession` at :372; `startSession` at :427-443; `endSession` deleteRoom block at :1159-1165)
- Test: extend `src/channels/voice/voice-runtime.test.ts`

**Interfaces:**
- Consumes: existing runtime internals only.
- Produces (changed signature, consumed by Task 6):
  - `StartVoiceSessionParams.transport?: AudioTransport` — when set, the runtime uses it directly; `createTransport` is not called; `deleteRoom` is skipped at teardown (external transports own their media lifecycle).
  - `StartVoiceSessionParams.agentToken` becomes optional: `agentToken?: string`. Runtime throws `new Error('startSession requires agentToken when no transport override is provided')` if both are absent.

- [ ] **Step 1: Write the failing tests** (append to `voice-runtime.test.ts`, reusing that file's existing fixture helpers — read its top ~80 lines first and mirror how existing tests construct the runtime, stt/tts fakes, and callers):

```typescript
describe('transport override (#1672)', () => {
  it('uses a provided transport, never calls createTransport, and skips deleteRoom', async () => {
    const provided = new FakeAudioTransport();
    const createTransport = vi.fn();
    const deleteRoom = vi.fn(async () => {});
    // build runtime exactly like the surrounding tests, but pass { createTransport, deleteRoom }
    const runtime = buildRuntime({ createTransport, deleteRoom }); // per this file's local helper pattern
    await runtime.startSession({
      sessionId: 'sess-ext',
      conversationId: 'voice:sess-ext',
      roomName: 'signal-call:42',
      caller: principalCaller(),
      transport: provided,
      openingGreeting: false,
    });
    expect(createTransport).not.toHaveBeenCalled();
    expect(provided.connected).toBe(true);
    await runtime.endSession('sess-ext', 'test_end');
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(provided.disconnectCount).toBe(1);
  });

  it('throws when neither agentToken nor transport is provided', async () => {
    const runtime = buildRuntime({});
    await expect(
      runtime.startSession({
        sessionId: 's', conversationId: 'voice:s', roomName: 'r', caller: principalCaller(),
      }),
    ).rejects.toThrow(/agentToken/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm -C <worktree> exec vitest run src/channels/voice/voice-runtime.test.ts` → FAIL (type error / runtime error on `transport` param).

- [ ] **Step 3: Implement**

In `StartVoiceSessionParams`: change `agentToken: string` to `agentToken?: string` and add:

```typescript
/**
 * Pre-built transport override (#1672). When set, createTransport is not
 * called and deleteRoom is skipped at teardown — the supplier owns the
 * media path lifecycle (e.g. SignalCallBridge / signal-cli tunnel).
 */
transport?: AudioTransport;
```

In `startSession` replace lines :433-438 with:

```typescript
let transport: RateAwareTransport;
if (params.transport) {
  transport = params.transport as RateAwareTransport;
} else {
  if (!params.agentToken) {
    throw new Error('startSession requires agentToken when no transport override is provided');
  }
  transport = this.config.createTransport({
    roomName: params.roomName,
    token: params.agentToken,
    livekitUrl: this.config.livekitUrl,
    callerIdentity: params.caller.contactId,
  }) as RateAwareTransport;
}
```

Add `externalTransport: boolean` to `ActiveSession` (set `externalTransport: params.transport !== undefined` in the session literal at :464-483), and guard the deleteRoom block at :1159: `if (this.config.deleteRoom && !session.externalTransport) {`.

- [ ] **Step 4: Run the FULL voice test suite** — `pnpm -C <worktree> exec vitest run src/channels/voice/` → PASS (console paths unaffected).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/voice/voice-runtime.ts src/channels/voice/voice-runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(voice): per-session transport override in VoiceRuntime (#1672)"
```

---

### Task 5: Signal caller resolution (answer-everyone policy input)

**Files:**
- Modify: `src/channels/voice/caller-context.ts` (add one function after `resolveVoiceCallerFromToken`; also update its `#1602` comment at :155-161 to point at the new function)
- Test: extend `src/channels/voice/caller-context.test.ts`

**Interfaces:**
- Consumes: `ContactResolver.resolve(channel: string, senderId: string): Promise<InboundSenderContext>` (`src/contacts/contact-resolver.ts:35`); existing private `toCallerContext` helper in this file.
- Produces (consumed by Task 6):

```typescript
export type ResolveSignalVoiceCallerResult =
  | { ok: true; caller: VoiceCallerContext }
  | { ok: false; reason: 'blocked' | 'no_identifier' };

export async function resolveSignalVoiceCaller(opts: {
  contactResolver: ContactResolver;
  /** E.164 from callEvent.number; may be null (uuid-only callers). */
  callerNumber: string | null;
  logger: Logger;
}): Promise<ResolveSignalVoiceCallerResult>;
```

**Behavior:** `callerNumber` null → `{ok:false, reason:'no_identifier'}` (cannot resolve or create a contact without a stable channel id; bridge rejects the call and logs the uuid). Otherwise resolve via `contactResolver.resolve('signal', callerNumber)` — the SAME channel key inbound Signal texts use, so an existing contact matches and principal standing comes from the verified Signal identity. `resolved && tier === 'blocked'` → `{ok:false, reason:'blocked'}`. Everything else — resolved contact OR unresolved stranger — is admitted (answer-everyone, Joseph 2026-08-20): `{ok:true, caller: toCallerContext(senderContext, 'voice', callerNumber)}`. An unresolved stranger yields tier `'unknown'`, `liveTurn` false via `stampOriginator`, displayName `'Unknown caller'`.

- [ ] **Step 1: Write the failing tests** (extend `caller-context.test.ts`; mirror its existing fake `ContactResolver` construction — read the file's existing `resolveVoiceCallerFromToken` tests and copy their fixture style exactly):

```typescript
describe('resolveSignalVoiceCaller (#1672)', () => {
  it('resolves the principal Signal number to a liveTurn caller', async () => {
    const resolver = fakeResolverReturning(principalSenderContext()); // per this file's existing fixture pattern
    const res = await resolveSignalVoiceCaller({ contactResolver: resolver, callerNumber: '+15196161377', logger });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.caller.liveTurn).toBe(true);
      expect(res.caller.senderId).toBe('+15196161377');
    }
    expect(resolver.resolve).toHaveBeenCalledWith('signal', '+15196161377');
  });

  it('admits an unresolved stranger as unknown tier without liveTurn', async () => {
    const resolver = fakeResolverReturning({ resolved: false });
    const res = await resolveSignalVoiceCaller({ contactResolver: resolver, callerNumber: '+15550001111', logger });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.caller.tier).toBe('unknown');
      expect(res.caller.liveTurn).toBe(false);
    }
  });

  it('rejects blocked contacts', async () => {
    const resolver = fakeResolverReturning(blockedSenderContext());
    const res = await resolveSignalVoiceCaller({ contactResolver: resolver, callerNumber: '+15550001111', logger });
    expect(res).toEqual({ ok: false, reason: 'blocked' });
  });

  it('rejects uuid-only callers with no number', async () => {
    const resolver = fakeResolverReturning({ resolved: false });
    const res = await resolveSignalVoiceCaller({ contactResolver: resolver, callerNumber: null, logger });
    expect(res).toEqual({ ok: false, reason: 'no_identifier' });
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL: `resolveSignalVoiceCaller` not exported.

- [ ] **Step 3: Implement** exactly per Behavior (≈25 lines; reuse `toCallerContext`). Also amend the stale comment block at :155-161: `resolveVoiceCallerFromToken` remains the token seam; Signal calls use `resolveSignalVoiceCaller` (this task).

- [ ] **Step 4: Run** `pnpm -C <worktree> exec vitest run src/channels/voice/caller-context.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/voice/caller-context.ts src/channels/voice/caller-context.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(voice): resolveSignalVoiceCaller — signal-channel caller resolution (#1672)"
```

---

### Task 6: SignalCallBridge (policy + lifecycle)

**Files:**
- Create: `src/channels/voice/signal/signal-call-bridge.ts`
- Test: `src/channels/voice/signal/signal-call-bridge.test.ts`

**Interfaces:**
- Consumes: `SignalRpcClient` events/methods (Task 2: `on('callEvent')`, `on('disconnected')`, `setCallEventsSubscription`, `acceptCall`, `rejectCall`, `hangupCall`); `SignalCallEvent` (Task 1); `SignalAudioTransport` + `SignalAudioTransportOpts` (Task 3); `VoiceRuntime.startSession` with `transport` override (Task 4) and `endSession(sessionId, reason)`; `resolveSignalVoiceCaller` (Task 5); `VoiceSessionStore` (`create`, session row shape at `src/channels/voice/session-store.ts:29-54`); `createVoiceSessionStarted` from `src/bus/events.js`; UUID guard pattern from `voice-adapter.ts:15` (copy the regex).
- Produces:

```typescript
export interface SignalCallBridgeConfig {
  bus: EventBus;
  logger: Logger;
  rpcClient: SignalRpcClient;
  contactResolver: ContactResolver;
  voiceRuntime: VoiceRuntime;
  sessionStore: VoiceSessionStore;
  pulseServer: string;
  /** Hard cap per call; default 600. */
  maxCallSeconds?: number;
  /** Injected for tests; defaults to (opts) => new SignalAudioTransport(opts). */
  createTransport?: (opts: SignalAudioTransportOpts) => AudioTransport & { notifyRemoteHangup(): void };
}
export class SignalCallBridge {
  constructor(config: SignalCallBridgeConfig);
  start(): void;   // subscribes; idempotent
  async stop(): Promise<void>;  // unsubscribes, hangs up + ends any active session
}
```

**Behavior (exact) — internal state `active: { callId: bigint; sessionId: string; transport: {notifyRemoteHangup(): void}; capTimer: NodeJS.Timeout | null; caller: VoiceCallerContext } | null` and `pending: Map<bigint, VoiceCallerContext>`:**

1. `start()`: `rpcClient.setCallEventsSubscription(true)`; attach `callEvent` + `disconnected` listeners (keep references for `stop()`).
2. `RINGING_INCOMING`:
   - If `active !== null` OR `pending.size > 0` → `void rpcClient.rejectCall(ev.callId)` and log `{ callId: ev.callId.toString(), reason: 'busy' }` at info. (Stringify bigints for pino.)
   - Else `resolveSignalVoiceCaller`. `ok:false` → `rejectCall` + info log with reason. `ok:true` → `pending.set(ev.callId, caller)`; `await rpcClient.acceptCall(ev.callId)`; on acceptCall rejection: log error, `pending.delete`.
3. `CONNECTED`:
   - `caller = pending.get(ev.callId)` (if absent → log warn, `hangupCall`, return — CONNECTED without our accept is a protocol surprise; never answer un-policied).
   - `pending.delete`; require `ev.inputDeviceName && ev.outputDeviceName` else `hangupCall` + error log.
   - `sessionId = randomUUID()`; `conversationId = 'voice:' + sessionId`; `roomName = 'signal-call:' + ev.callId.toString()`.
   - `sessionStore.create({ id: sessionId, conversationId, livekitRoom: roomName, principalContactId: UUID_RE.test(caller.contactId) ? caller.contactId : undefined, metadata: { channel: 'signal', callerNumber: ev.number, callId: ev.callId.toString(), tier: caller.tier } })`; publish `createVoiceSessionStarted({ sessionId, conversationId, livekitRoom: roomName })`.
   - Build transport via `config.createTransport ?? (o => new SignalAudioTransport(o))` with `{ pulseServer, inputDeviceName, outputDeviceName, logger }`.
   - Set `active = { callId, sessionId, transport, capTimer, caller }`; `capTimer = setTimeout(() => void this.enforceCap(), maxCallSeconds * 1000)`.
   - `await voiceRuntime.startSession({ sessionId, conversationId, roomName, caller, transport, openingGreeting: true })`; on throw: end everything (`hangupCall`, `voiceRuntime.endSession(sessionId, 'runtime_start_failed')`, clear state) — mirror `voice-adapter.ts:158-168`.
4. `ENDED` (matching `active.callId`): clear capTimer; `active.transport.notifyRemoteHangup()` (drives runtime teardown via onClose); ALSO schedule a safety `void voiceRuntime.endSession(active.sessionId, 'remote_hangup')` — endSession is idempotent via the store dedupe (`voice-runtime.ts:1168-1178`); clear `active`. `ENDED` for a pending (never-connected) call: just `pending.delete` + info log.
5. `enforceCap()`: log info; `void rpcClient.hangupCall(callId)`; `void voiceRuntime.endSession(sessionId, 'max_duration')`; clear `active`. (v1 keeps it blunt — no wrap-up turn; the runtime teardown cancels any mid-turn speech. The spec's wrap-up line is noted as a fast-follow in the CHANGELOG entry.)

   *Deviation from spec, deliberate:* the spec sketches a spoken wrap-up before cap-hangup; that requires injecting a synthetic turn mid-session, which touches the turn loop. v1 hard-stops at the cap; #1672 gets a checklist note.
6. `disconnected` (RPC socket lost) while `active`: `void voiceRuntime.endSession(active.sessionId, 'rpc_disconnected')`; clear state; error log. (Re-subscribe is automatic — Task 2.)
7. `stop()`: remove listeners; `setCallEventsSubscription(false)`; if `active`: `hangupCall` best-effort + `endSession(sessionId, 'adapter_stop')`.
8. Every handler body is wrapped so a throw is caught and error-logged (`callEvent` arrives on an EventEmitter — an unhandled throw would crash the process).

- [ ] **Step 1: Write the failing tests** — fake `rpcClient` (an `EventEmitter` with `vi.fn()` methods), fake runtime (`startSession`/`endSession` spies), real-ish store fake (`create` spy returning the row shape), fake transport factory returning a `FakeAudioTransport`-plus-`notifyRemoteHangup` object. Cases:

```typescript
// src/channels/voice/signal/signal-call-bridge.test.ts — test names (write full bodies):
it('subscribes for call events on start');
it('accepts a ringing call for a resolvable caller and starts a runtime session on CONNECTED with the signal transport');
it('persists a voice_sessions row with channel=signal metadata and publishes voice.session.started');
it('rejects a second incoming call while one is active (busy)');
it('rejects blocked callers and never accepts');
it('rejects uuid-only callers (no_identifier)');
it('admits an unknown caller with tier unknown and liveTurn false (answer-everyone)');
it('hangs up instead of starting a session when CONNECTED arrives without a pending accept');
it('on ENDED notifies the transport (remote hangup) and ends the runtime session');
it('enforces the max-duration cap: hangupCall + endSession(max_duration)');
it('ends the session with rpc_disconnected when the socket drops mid-call');
it('stop() hangs up and ends an active session');
```

For the CONNECTED test, emit: `rpc.emit('callEvent', { callId: 42n, state: 'RINGING_INCOMING', number: '+15196161377', uuid: null, isOutgoing: false, inputDeviceName: 'signal_input_42', outputDeviceName: 'signal_output_42', reason: null })` then the same with `state: 'CONNECTED'`, and `await vi.waitFor(...)` on the spies (handlers are async). For the cap test use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(600_000)`.

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `signal-call-bridge.ts`** per Behavior. Import `randomUUID` from `node:crypto`. Copy `UUID_RE` from `voice-adapter.ts:15` (do not export it from there — keep the copy with a pointer comment).

- [ ] **Step 4: Run** `pnpm -C <worktree> exec vitest run src/channels/voice/signal/` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/voice/signal/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(voice): SignalCallBridge — answer policy, lifecycle, duration cap (#1672)"
```

---

### Task 7: Config + bootstrap wiring

**Files:**
- Modify: `src/config.ts` (Config interface near :48-49; env loading near :1298)
- Modify: `src/index.ts` (voice adapter block :1865-1961 — hoist a `voiceRuntimeRef`; new bridge construction after the voice block; shutdown path — grep `endAllSessions\|adapter_stop` and stop the bridge alongside the voice adapter's stop)
- Test: none new (bootstrap is not unit-tested in this repo); verified by typecheck + full suite + Task 8.

**Interfaces:**
- Consumes: everything from Tasks 2-6; existing `contactResolver` (`src/index.ts:693`), `signalRpcClient` (:861-872), `voiceSessionStore`, `voiceRuntime` (:1909).
- Produces: `config.signalVoiceCallsEnabled: boolean`, `config.signalPulseSocketPath: string | undefined`, `config.signalVoiceMaxCallSeconds: number`.

- [ ] **Step 1: Add config fields**

In the `Config` interface (after `signalPhoneNumber` at :49):

```typescript
  // Signal voice calls (#1672) — dark by default. Requires the voice stack
  // (LiveKit creds not needed, but Deepgram/Cartesia are) AND the Signal channel.
  signalVoiceCallsEnabled: boolean;
  // PulseAudio native socket shared from the signal-cli container.
  signalPulseSocketPath: string | undefined;
  // Hard per-call duration cap (answer-everyone guardrail).
  signalVoiceMaxCallSeconds: number;
```

In the env-loading object (near :1298):

```typescript
    signalVoiceCallsEnabled: process.env.SIGNAL_VOICE_CALLS_ENABLED?.trim().toLowerCase() === 'true',
    signalPulseSocketPath: process.env.SIGNAL_PULSE_SOCKET_PATH?.trim() || undefined,
    signalVoiceMaxCallSeconds: Number.parseInt(process.env.SIGNAL_VOICE_MAX_CALL_SECONDS ?? '', 10) > 0
      ? Number.parseInt(process.env.SIGNAL_VOICE_MAX_CALL_SECONDS!, 10)
      : 600,
```

- [ ] **Step 2: Wire the bridge in `src/index.ts`**

Hoist the runtime out of the voice block: declare `let voiceRuntimeRef: VoiceRuntime | undefined;` beside `let voiceAdapter: VoiceAdapter | undefined;` (:912) and set `voiceRuntimeRef = voiceRuntime;` right after construction (:1943). After the voice adapter block (below :1961), add:

```typescript
  // Signal voice calls (#1672): bridge signal-cli callEvents into VoiceRuntime.
  // Dark by default — requires the flag, the Signal RPC client, the voice
  // runtime, and the shared Pulse socket path.
  let signalCallBridge: SignalCallBridge | undefined;
  if (config.signalVoiceCallsEnabled) {
    if (signalRpcClient && voiceRuntimeRef && config.signalPulseSocketPath) {
      signalCallBridge = new SignalCallBridge({
        bus,
        logger,
        rpcClient: signalRpcClient,
        contactResolver,
        voiceRuntime: voiceRuntimeRef,
        sessionStore: voiceSessionStore,
        pulseServer: config.signalPulseSocketPath,
        maxCallSeconds: config.signalVoiceMaxCallSeconds,
      });
      signalCallBridge.start();
      logger.info({ maxCallSeconds: config.signalVoiceMaxCallSeconds }, 'Signal voice-call bridge started');
    } else {
      logger.warn(
        {
          hasSignalRpc: !!signalRpcClient,
          hasVoiceRuntime: !!voiceRuntimeRef,
          hasPulseSocket: !!config.signalPulseSocketPath,
        },
        'SIGNAL_VOICE_CALLS_ENABLED is set but prerequisites are missing; Signal voice calls disabled',
      );
    }
  }
```

Add `import { SignalCallBridge } from './channels/voice/signal/signal-call-bridge.js';` with the other voice imports (:82-85). In the shutdown sequence (find where `voiceAdapter`/channels are stopped — grep `\.stop\(\)` around the shutdown handler), add `if (signalCallBridge) await signalCallBridge.stop();` BEFORE the voice adapter stop (bridge owns live calls).

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/config.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "feat(voice): config gate + bootstrap wiring for Signal voice calls (#1672)"
```

---

### Task 8: Integration test — bridge drives a real VoiceRuntime session

**Files:**
- Create: `src/channels/voice/signal/signal-call-integration.test.ts`

**Interfaces:** consumes everything above; produces nothing (proof).

- [ ] **Step 1: Write the test.** Construct a REAL `VoiceRuntime` exactly the way `voice-runtime.test.ts` does (fake stt/tts/llm/bus/sessionStore fixtures — reuse `test-fixtures.ts` / that file's helpers), a fake rpcClient (EventEmitter + spies), and a real `SignalCallBridge` whose `createTransport` returns a `FakeAudioTransport` subclass with `notifyRemoteHangup() { this.emitClose('principal_disconnected'); }`. Script:

1. `bridge.start()` → emit RINGING_INCOMING (principal number) → `vi.waitFor` acceptCall spy.
2. Emit CONNECTED → `vi.waitFor(() => runtime.activeSessionCount === 1)`; assert `sessionStore.create` got `metadata.channel === 'signal'` and the greeting turn ran (fake LLM invoked — same assertion style as existing greeting tests in `voice-runtime.test.ts` / `greeting.test.ts`).
3. Emit ENDED (`reason: 'RemoteHangup'`) → `vi.waitFor(() => runtime.activeSessionCount === 0)`; assert transport `disconnectCount === 1` and `voice.session.ended` was published with the session's id.

- [ ] **Step 2: Run it** — `pnpm -C <worktree> exec vitest run src/channels/voice/signal/signal-call-integration.test.ts` → PASS (fix whatever it flushes out; this test exists to catch seam mismatches between Tasks 2-7).

- [ ] **Step 3: Full suite + typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls exec vitest run
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add src/channels/voice/signal/signal-call-integration.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "test(voice): signal call bridge end-to-end against real VoiceRuntime (#1672)"
```

---

### Task 9: CHANGELOG + docs touch-ups

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]` → `### Added`)
- Modify: `docs/dev/voice-setup.md` (line 5 area: Signal calling is no longer "Phase 2 future" — brief section: env vars `SIGNAL_VOICE_CALLS_ENABLED`, `SIGNAL_PULSE_SOCKET_PATH`, `SIGNAL_VOICE_MAX_CALL_SECONDS`; note deploy prerequisites land via curia-deploy and the feature is off by default)

- [ ] **Step 1: CHANGELOG entry** (15-word cap after the em-dash):

```markdown
- **Signal voice calls** — anyone can Signal-call Curia; live conversation via VoiceRuntime, config-gated off. (#1672)
```

- [ ] **Step 2: voice-setup.md** — add a short "Signal calls (experimental)" section listing the three env vars, the answer-everyone + duration-cap policy, and that signal-cli ≥0.14.7 + signal-call-tunnel + shared Pulse socket come from curia-deploy.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls add CHANGELOG.md docs/dev/voice-setup.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-voice-calls commit -s -m "docs: changelog + voice-setup notes for Signal voice calls (#1672)"
```

---

## Post-plan (not tasks — session-level follow-ups)

1. Pre-PR reviews per global CLAUDE.md: `pr-review-toolkit:code-reviewer` + `pr-review-toolkit:silent-failure-hunter` in parallel (channel + subprocess code: the hunter matters here).
2. Manual E2E before merge: adapt `office-of-the-ceo/spikes/signal-call-spike-1602/` — run signal-cli daemon + Pulse in the spike container with the socket volume exposed to the host, point a locally-running Curia (`pnpm dev`, dev DB, flag on) at it, real phone call: greeting, multi-turn, barge-in, hangup. Record the result on #1672.
3. PR: `Closes #1672` in body; confirm CI starts (`gh run list --branch feat/signal-voice-calls --limit 1`).
4. File the curia-deploy companion issue (image bump ≥0.14.7 + tunnel build + Pulse socket volume + runbook) — checklist item in #1672.
5. Note on #1672: cap wrap-up line deferred (Task 6 deviation).

## Self-review notes (already applied)

- Spec coverage: every spec component maps to a task (RPC→2, transport→3, runtime override→4, resolution→5, bridge/policy/cap/busy→6, config/wiring→7, integration→8, docs→9; deploy explicitly out of scope here).
- Deviation logged: no spoken wrap-up at the duration cap in v1 (Task 6, noted for #1672).
- Type consistency: `SignalCallEvent.callId: bigint` consumed as bigint in Tasks 2/6; `notifyRemoteHangup` defined in Task 3, required by Task 6's `createTransport` type and Task 8's fake; `transport` override param name consistent across Tasks 4/6/8.
