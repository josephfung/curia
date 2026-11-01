// The phone mutes the local mic when the installed app is backgrounded.
// LiveKit's room TrackMuted event does not fire for that path: the OS mute
// becomes TrackEvent.UpstreamPaused after a debounce, and the underlying
// MediaStreamTrack fires mute immediately. A Mute-button press is a different
// event and is ignored here via isUserMute.

import { TrackEvent } from 'livekit-client';

/** Participant attribute the console sets before a Mute-button press. */
export const USER_MUTE_ATTRIBUTE = 'curia.mute';
export const USER_MUTE_VALUE = 'user';

export interface PausableMicTrack {
  readonly mediaStreamTrack: MediaStreamTrack;
  readonly isUpstreamPaused: boolean;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
}

/** Whether the mic is held by the OS right now, whatever events fired before. */
export function isMicPaused(track: PausableMicTrack): boolean {
  return track.mediaStreamTrack.muted || track.isUpstreamPaused;
}

/**
 * Listen for an OS mute on the local mic. `getTrack` is read again after
 * TrackEvent.Restarted, because a foregrounded phone replaces the stream.
 * Returns an unbind function.
 */
export function bindMicPause(
  getTrack: () => PausableMicTrack,
  opts: {
    isUserMute: () => boolean;
    onPaused: () => void;
    onResumed: () => void;
  },
): () => void {
  const track = getTrack();
  let stream = track.mediaStreamTrack;

  const onPaused = () => {
    if (opts.isUserMute()) return;
    opts.onPaused();
  };
  const onResumed = () => {
    opts.onResumed();
  };
  const attachStream = (next: MediaStreamTrack) => {
    next.addEventListener('mute', onPaused);
    next.addEventListener('unmute', onResumed);
  };
  const detachStream = (prev: MediaStreamTrack) => {
    prev.removeEventListener('mute', onPaused);
    prev.removeEventListener('unmute', onResumed);
  };

  attachStream(stream);

  const onRestarted = () => {
    detachStream(stream);
    // Keep `track` as the object the listeners were bound to. Replacing it
    // made unbind remove them from the new track and leave the original live.
    const next = getTrack();
    stream = next.mediaStreamTrack;
    attachStream(stream);
    // A foregrounded phone replaces the stream without an unmute event.
    if (!stream.muted && !next.isUpstreamPaused) {
      opts.onResumed();
    }
  };

  track.on(TrackEvent.UpstreamPaused, onPaused);
  track.on(TrackEvent.UpstreamResumed, onResumed);
  track.on(TrackEvent.Restarted, onRestarted);

  // The mic can be paused before these listeners exist (a slow publish while
  // the app is backgrounded), so its mute events have already fired.
  if (isMicPaused(track)) onPaused();

  return () => {
    detachStream(stream);
    track.off(TrackEvent.UpstreamPaused, onPaused);
    track.off(TrackEvent.UpstreamResumed, onResumed);
    track.off(TrackEvent.Restarted, onRestarted);
  };
}
