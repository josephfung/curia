import { describe, expect, it, vi } from 'vitest';
import { TrackEvent } from 'livekit-client';
import { bindMicPause, type PausableMicTrack } from './mic-pause.js';

class FakeStream extends EventTarget {
  muted = false;
  constructor(readonly label: string) {
    super();
  }
}

function fakeTrack(stream: FakeStream): PausableMicTrack & {
  emit: (event: string) => void;
  listeners: Map<string, Set<() => void>>;
  isUpstreamPaused: boolean;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    get mediaStreamTrack() {
      return stream as unknown as MediaStreamTrack;
    },
    isUpstreamPaused: false,
    listeners,
    on(event: string, cb: () => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    },
    off(event: string, cb: () => void) {
      listeners.get(event)?.delete(cb);
    },
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
}

describe('bindMicPause', () => {
  it('shows a pause on an OS mute and ignores a Mute-button mute', () => {
    const stream = new FakeStream('mic');
    const track = fakeTrack(stream);
    const paused = vi.fn();
    const resumed = vi.fn();
    let userMute = false;
    const unbind = bindMicPause(() => track, {
      isUserMute: () => userMute,
      onPaused: paused,
      onResumed: resumed,
    });

    stream.dispatchEvent(new Event('mute'));
    expect(paused).toHaveBeenCalledTimes(1);
    stream.dispatchEvent(new Event('unmute'));
    expect(resumed).toHaveBeenCalledTimes(1);

    userMute = true;
    stream.dispatchEvent(new Event('mute'));
    track.emit(TrackEvent.UpstreamPaused);
    expect(paused).toHaveBeenCalledTimes(1);

    userMute = false;
    track.emit(TrackEvent.UpstreamPaused);
    expect(paused).toHaveBeenCalledTimes(2);
    track.emit(TrackEvent.UpstreamResumed);
    expect(resumed).toHaveBeenCalledTimes(2);

    unbind();
    stream.dispatchEvent(new Event('mute'));
    track.emit(TrackEvent.UpstreamPaused);
    expect(paused).toHaveBeenCalledTimes(2);
  });

  it('rebinds the media stream after the track restarts', () => {
    const first = new FakeStream('first');
    const second = new FakeStream('second');
    let current = first;
    const track = fakeTrack(first);
    Object.defineProperty(track, 'mediaStreamTrack', { get: () => current as unknown as MediaStreamTrack });
    const paused = vi.fn();
    bindMicPause(() => track, {
      isUserMute: () => false,
      onPaused: paused,
      onResumed: () => undefined,
    });

    track.emit(TrackEvent.Restarted);
    current = second;
    track.emit(TrackEvent.Restarted);

    first.dispatchEvent(new Event('mute'));
    expect(paused).not.toHaveBeenCalled();
    second.dispatchEvent(new Event('mute'));
    expect(paused).toHaveBeenCalledTimes(1);
  });

  it('unbinds the original track after a restart, and clears a pause when the new mic is live', () => {
    const first = new FakeStream('first');
    const second = new FakeStream('second');
    const original = fakeTrack(first);
    const replacement = fakeTrack(second);
    let current: PausableMicTrack = original;
    const paused = vi.fn();
    const resumed = vi.fn();
    const unbind = bindMicPause(() => current, {
      isUserMute: () => false,
      onPaused: paused,
      onResumed: resumed,
    });

    current = replacement;
    original.emit(TrackEvent.Restarted);
    expect(resumed).toHaveBeenCalledTimes(1);

    unbind();
    original.emit(TrackEvent.UpstreamPaused);
    original.emit(TrackEvent.Restarted);
    replacement.emit(TrackEvent.UpstreamPaused);
    expect(paused).not.toHaveBeenCalled();
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('stays paused when the restarted mic is still muted or upstream-paused', () => {
    const stillMuted = new FakeStream('muted');
    stillMuted.muted = true;
    const original = fakeTrack(new FakeStream('first'));
    let current: PausableMicTrack = original;
    const resumed = vi.fn();
    bindMicPause(() => current, {
      isUserMute: () => false,
      onPaused: () => undefined,
      onResumed: resumed,
    });
    current = fakeTrack(stillMuted);
    original.emit(TrackEvent.Restarted);
    expect(resumed).not.toHaveBeenCalled();

    const upstream = fakeTrack(new FakeStream('upstream'));
    upstream.isUpstreamPaused = true;
    const again = fakeTrack(new FakeStream('again'));
    current = again;
    const resumedAgain = vi.fn();
    bindMicPause(() => current, {
      isUserMute: () => false,
      onPaused: () => undefined,
      onResumed: resumedAgain,
    });
    current = upstream;
    again.emit(TrackEvent.Restarted);
    expect(resumedAgain).not.toHaveBeenCalled();
  });
});