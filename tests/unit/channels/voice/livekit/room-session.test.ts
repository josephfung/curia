// room-session.test.ts — unit tests for LiveKitRoomSession.
//
// @livekit/rtc-node is a native addon loaded lazily via dynamic import() inside
// connect(). Tests mock the package so no native binary is needed, and drive
// the real ParticipantDisconnected handler — the regression that previously
// silently broke session teardown when LiveKit identity changed (#1598).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { LiveKitRoomSession } from '../../../../../src/channels/voice/livekit/room-session.js';

const logger = pino({ level: 'silent' });

// vi.mock is hoisted — declare the shared handler map with vi.hoisted() to avoid TDZ.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock('@livekit/rtc-node', () => ({
  Room: class {
    localParticipant = { publishTrack: vi.fn(async () => undefined) };
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb);
      return this;
    }
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
  },
  RoomEvent: {
    TrackSubscribed: 'TrackSubscribed',
    ParticipantDisconnected: 'ParticipantDisconnected',
    Disconnected: 'Disconnected',
    TrackMuted: 'TrackMuted',
    TrackUnmuted: 'TrackUnmuted',
    ParticipantAttributesChanged: 'ParticipantAttributesChanged',
  },
  TrackKind: { KIND_AUDIO: 1 },
  TrackSource: { SOURCE_MICROPHONE: 0 },
  AudioSource: class {
    close = vi.fn(async () => undefined);
    captureFrame = vi.fn(async () => undefined);
  },
  LocalAudioTrack: class {
    close = vi.fn(async () => undefined);
    static createAudioTrack = vi.fn(() => new (this as unknown as { new (): unknown })());
  },
  AudioStream: class {
    getReader() {
      return {
        read: vi.fn(async () => ({ done: true, value: undefined })),
        releaseLock: vi.fn(),
        cancel: vi.fn(async () => undefined),
      };
    }
  },
  AudioFrame: class {},
  TrackPublishOptions: class {
    constructor(_opts: unknown) {}
  },
}));

describe('LiveKitRoomSession — ParticipantDisconnected teardown (#1598)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('fires onClose when the resolved caller identity disconnects', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const session = new LiveKitRoomSession({
      url: 'wss://livekit.test',
      token: 'tok',
      callerIdentity: uuid,
      logger,
    });
    const closed: string[] = [];
    session.onClose(r => closed.push(r));
    await session.connect();

    handlers.get('ParticipantDisconnected')!({ identity: uuid });
    expect(closed).toEqual(['principal_disconnected']);
  });

  it('ignores a disconnect from any other participant identity', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const session = new LiveKitRoomSession({
      url: 'wss://livekit.test',
      token: 'tok',
      callerIdentity: uuid,
      logger,
    });
    const closed: string[] = [];
    session.onClose(r => closed.push(r));
    await session.connect();

    handlers.get('ParticipantDisconnected')!({ identity: 'curia-agent' });
    expect(closed).toEqual([]);
  });

  it('does not fire onClose for the literal "principal" when callerIdentity is a contact id', async () => {
    // Sanity: the exact pre-#1598 regression — comparing against the hardcoded
    // 'principal' string while the minted identity is a UUID — must not match.
    const uuid = '22222222-2222-2222-2222-222222222222';
    const session = new LiveKitRoomSession({
      url: 'wss://livekit.test',
      token: 'tok',
      callerIdentity: uuid,
      logger,
    });
    const closed: string[] = [];
    session.onClose(r => closed.push(r));
    await session.connect();

    handlers.get('ParticipantDisconnected')!({ identity: 'principal' });
    expect(closed).toEqual([]);
  });

  it('fires onClose for RoomEvent.Disconnected', async () => {
    const session = new LiveKitRoomSession({
      url: 'wss://livekit.test',
      token: 'tok',
      callerIdentity: '11111111-1111-1111-1111-111111111111',
      logger,
    });
    const closed: string[] = [];
    session.onClose(r => closed.push(r));
    await session.connect();

    handlers.get('Disconnected')!(undefined);
    expect(closed).toEqual(['room_disconnected']);
  });

  it('treats an OS mute as a pause and ignores a Mute-button mute', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const session = new LiveKitRoomSession({
      url: 'wss://livekit.test',
      token: 'tok',
      callerIdentity: uuid,
      logger,
    });
    const muted: boolean[] = [];
    session.onCallerMuted(value => muted.push(value));
    await session.connect();

    const audio = { kind: 1 };
    const other = { identity: 'curia-agent', attributes: {} };
    handlers.get('TrackMuted')!(audio, other);
    expect(muted).toEqual([]);

    const user = { identity: uuid, attributes: { 'curia.mute': 'user' } };
    handlers.get('TrackMuted')!(audio, user);
    expect(muted).toEqual([]);

    const phone = { identity: uuid, attributes: {} };
    handlers.get('TrackMuted')!(audio, phone);
    handlers.get('TrackMuted')!({ kind: 2 }, phone);
    expect(muted).toEqual([true]);

    handlers.get('ParticipantAttributesChanged')!({ 'curia.mute': 'user' }, user);
    expect(muted).toEqual([true, false]);

    handlers.get('TrackUnmuted')!(audio, phone);
    expect(muted).toEqual([true, false, false]);
  });
});
