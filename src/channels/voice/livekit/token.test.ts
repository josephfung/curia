import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mintVoiceParticipantToken, deleteVoiceRoom, DEFAULT_VOICE_TOKEN_TTL } from './token.js';

const { deleteRoomMock, roomServiceCtor } = vi.hoisted(() => {
  const deleteRoomMock = vi.fn(async () => {});
  const roomServiceCtor = vi.fn(function RoomServiceClient(
    this: unknown,
    host: string,
    apiKey: string,
    apiSecret: string,
  ) {
    return { deleteRoom: deleteRoomMock, host, apiKey, apiSecret };
  });
  return { deleteRoomMock, roomServiceCtor };
});

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return {
    ...actual,
    RoomServiceClient: roomServiceCtor,
  };
});

describe('mintVoiceParticipantToken', () => {
  it('sets an explicit TTL (default 1h) so leaked JWTs expire promptly', async () => {
    // AccessToken encodes ttl into the JWT `exp` claim. Decode without verify.
    const jwt = await mintVoiceParticipantToken(
      { apiKey: 'devkey', apiSecret: 'secret'.padEnd(32, 'x') },
      { roomName: 'voice-test', identity: 'principal' },
    );
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as {
      exp: number;
      iat?: number;
      video?: { room: string; roomJoin: boolean };
    };
    expect(payload.video?.room).toBe('voice-test');
    expect(payload.video?.roomJoin).toBe(true);
    const iat = payload.iat ?? Math.floor(Date.now() / 1000);
    const lifetimeSec = payload.exp - iat;
    // 1h ± a few seconds of clock skew in encoding
    expect(lifetimeSec).toBeGreaterThan(3500);
    expect(lifetimeSec).toBeLessThanOrEqual(3600 + 5);
    expect(DEFAULT_VOICE_TOKEN_TTL).toBe('1h');
  });

  it('honors an explicit ttl override', async () => {
    const jwt = await mintVoiceParticipantToken(
      { apiKey: 'devkey', apiSecret: 'secret'.padEnd(32, 'x') },
      { roomName: 'voice-test', identity: 'principal', ttl: '15m' },
    );
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as {
      exp: number;
      iat?: number;
    };
    const iat = payload.iat ?? Math.floor(Date.now() / 1000);
    const lifetimeSec = payload.exp - iat;
    expect(lifetimeSec).toBeGreaterThan(800);
    expect(lifetimeSec).toBeLessThanOrEqual(900 + 5);
  });
});

describe('deleteVoiceRoom', () => {
  beforeEach(() => {
    deleteRoomMock.mockClear();
    roomServiceCtor.mockClear();
  });

  it('builds RoomServiceClient against the management HTTP URL, not signaling', async () => {
    await deleteVoiceRoom(
      {
        livekitManagementUrl: 'http://livekit:7880',
        apiKey: 'devkey',
        apiSecret: 'secret'.padEnd(32, 'x'),
      },
      'voice-room-1',
    );
    expect(roomServiceCtor).toHaveBeenCalledWith(
      'http://livekit:7880',
      'devkey',
      'secret'.padEnd(32, 'x'),
    );
    expect(deleteRoomMock).toHaveBeenCalledWith('voice-room-1');
  });

  it('maps accidental ws(s) management URLs to http(s)', async () => {
    await deleteVoiceRoom(
      {
        livekitManagementUrl: 'wss://livekit.internal:7880',
        apiKey: 'devkey',
        apiSecret: 'secret'.padEnd(32, 'x'),
      },
      'voice-room-2',
    );
    expect(roomServiceCtor).toHaveBeenCalledWith(
      'https://livekit.internal:7880',
      'devkey',
      'secret'.padEnd(32, 'x'),
    );
  });
});
