import { describe, expect, it } from 'vitest';
import { liveKitJoinUrl } from '../../../../../src/channels/voice/livekit/server-url.js';

describe('liveKitJoinUrl', () => {
  it('defaults to the management URL as a ws URL', () => {
    expect(liveKitJoinUrl('http://livekit:7880', {})).toBe('ws://livekit:7880');
    expect(liveKitJoinUrl('https://lk.example.com', {})).toBe('wss://lk.example.com');
  });

  it('uses LIVEKIT_INTERNAL_URL when set', () => {
    expect(liveKitJoinUrl('http://livekit:7880', { LIVEKIT_INTERNAL_URL: 'ws://localhost:7880' })).toBe('ws://localhost:7880');
    expect(liveKitJoinUrl('http://livekit:7880', { LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880' })).toBe('ws://127.0.0.1:7880');
  });

  it('ignores an empty override', () => {
    expect(liveKitJoinUrl('http://livekit:7880', { LIVEKIT_INTERNAL_URL: '  ' })).toBe('ws://livekit:7880');
  });
});
