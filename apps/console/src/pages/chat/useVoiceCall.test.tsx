// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_MUTE_VALUE } from './mic-pause.js';
import { useVoiceCall } from './useVoiceCall.js';

const { apiFetch, mic } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mic: {
    order: [] as string[],
    on: true,
    fail: null as null | 'enable' | 'disable',
  },
}));

vi.mock('../../api.js', () => ({ apiFetch }));

vi.mock('livekit-client', () => {
  class Room {
    remoteParticipants = new Map();
    localParticipant = {
      get isMicrophoneEnabled() {
        return mic.on;
      },
      setAttributes: async (attrs: Record<string, string>) => {
        mic.order.push(`attr:${attrs['curia.mute'] ?? ''}`);
      },
      setMicrophoneEnabled: async (enabled: boolean) => {
        mic.order.push(enabled ? 'mic-on' : 'mic-off');
        if (mic.fail === 'enable' && enabled) throw new Error('mic failed');
        if (mic.fail === 'disable' && !enabled) throw new Error('mic failed');
        mic.on = enabled;
      },
      getTrackPublication: () => undefined,
    };
    on(): this {
      return this;
    }
    async connect(): Promise<void> {}
    removeAllListeners(): void {}
    disconnect(): void {}
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: 'TrackSubscribed',
      TrackUnsubscribed: 'TrackUnsubscribed',
      ActiveSpeakersChanged: 'ActiveSpeakersChanged',
      LocalTrackPublished: 'LocalTrackPublished',
      Disconnected: 'Disconnected',
    },
    Track: { Source: { Microphone: 'microphone' }, Kind: { Audio: 'audio' } },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe(): ReactElement {
  const call = useVoiceCall();
  return (
    <div>
      <p data-testid="state">{call.callState}</p>
      <p data-testid="muted">{call.muted ? 'yes' : 'no'}</p>
      <p data-testid="error">{call.error ?? ''}</p>
      <button type="button" onClick={() => { void call.startCall(); }}>start</button>
      <button type="button" onClick={() => { void call.toggleMute(); }}>mute</button>
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function text(testId: string): string {
  return container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  await flush();
}

async function click(label: string): Promise<void> {
  const button = [...(container?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  await act(async () => {
    button.click();
  });
  for (let i = 0; i < 10; i += 1) await flush();
}

beforeEach(() => {
  mic.order = [];
  mic.on = true;
  mic.fail = null;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/voice/status') return Promise.resolve(json(200, { enabled: true }));
    if (path === '/api/voice/sessions' && init?.method === 'POST') {
      return Promise.resolve(json(200, {
        sessionId: 's1',
        conversationId: 'voice:s1',
        livekitUrl: 'ws://localhost',
        token: 'tok',
        roomName: 'room',
      }));
    }
    return Promise.resolve(json(200, {}));
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('useVoiceCall toggleMute', () => {
  it('clears the mute mark before the microphone comes back', async () => {
    await mount();
    await click('start');
    expect(text('state')).toBe('connected');

    mic.order = [];
    await click('mute');
    expect(mic.order).toEqual([`attr:${USER_MUTE_VALUE}`, 'mic-off']);
    expect(text('muted')).toBe('yes');

    mic.order = [];
    await click('mute');
    expect(mic.order).toEqual(['attr:', 'mic-on']);
    expect(text('muted')).toBe('no');
    expect(text('error')).toBe('');
  });

  it('matches the mute mark to the microphone when either step fails', async () => {
    await mount();
    await click('start');
    expect(text('state')).toBe('connected');

    mic.fail = 'disable';
    mic.order = [];
    await click('mute');
    expect(mic.order).toEqual([`attr:${USER_MUTE_VALUE}`, 'mic-off', 'attr:']);
    expect(text('muted')).toBe('no');
    expect(text('error')).toBe('mic failed');

    mic.fail = null;
    mic.order = [];
    await click('mute');
    expect(text('muted')).toBe('yes');

    mic.fail = 'enable';
    mic.order = [];
    await click('mute');
    expect(mic.order).toEqual(['attr:', 'mic-on', `attr:${USER_MUTE_VALUE}`]);
    expect(text('muted')).toBe('yes');
    expect(mic.on).toBe(false);
  });
});
