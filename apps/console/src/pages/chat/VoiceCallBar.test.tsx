import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallBar } from './VoiceCallBar.js';
import type { UseVoiceCallResult } from './useVoiceCall.js';

function props(overrides: Partial<UseVoiceCallResult> = {}): UseVoiceCallResult {
  return {
    voiceAvailable: true,
    callState: 'idle',
    muted: false,
    error: null,
    sessionId: null,
    startCall: vi.fn(),
    toggleMute: vi.fn(),
    hangUp: vi.fn(),
    ...overrides,
  };
}

describe('VoiceCallBar (#1571)', () => {
  it('renders a Voice start control when idle', () => {
    const html = renderToStaticMarkup(<VoiceCallBar {...props()} />);
    expect(html).toContain('Voice');
    expect(html).toContain('voice-call-start');
    expect(html).toContain('Start voice call');
  });

  it('renders connecting status with muted mute control', () => {
    const html = renderToStaticMarkup(<VoiceCallBar {...props({ callState: 'connecting' })} />);
    expect(html).toContain('Connecting');
    expect(html).toContain('disabled');
    expect(html).toContain('Hang up');
  });

  it('renders in-call mute and hang up when connected', () => {
    const html = renderToStaticMarkup(<VoiceCallBar {...props({ callState: 'connected' })} />);
    expect(html).toContain('Listening');
    expect(html).toContain('Mute');
    expect(html).toContain('Hang up');
  });

  it('renders retry when error', () => {
    const html = renderToStaticMarkup(
      <VoiceCallBar {...props({ callState: 'error', error: 'LiveKit unreachable' })} />,
    );
    expect(html).toContain('Try again');
    expect(html).toContain('LiveKit unreachable');
  });

  it('hides when voice is unavailable and idle', () => {
    const html = renderToStaticMarkup(
      <VoiceCallBar {...props({ voiceAvailable: false, callState: 'idle' })} />,
    );
    expect(html).toBe('');
  });
});
