import { describe, it, expect, vi } from 'vitest';
import { mintVoiceParticipantToken, DEFAULT_VOICE_TOKEN_TTL } from './token.js';

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

// Silence unused vi import if needed — keep for future mocks.
void vi;
