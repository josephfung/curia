// audio-transport.ts — the seam between VoiceRuntime and whatever carries PCM
// audio to/from the principal. Phase 1 has one real implementation
// (LiveKitRoomSession, console WebRTC) and a FakeAudioTransport for tests.
//
// Keeping this an interface lets VoiceRuntime stay transport-agnostic: Phase 2
// transports (Signal RingRTC, SIP) plug in here without touching the runtime or
// the speech providers.

import type { PcmFrame } from '../../speech/index.js';

export type AudioTransportCloseReason =
  | 'principal_disconnected'
  | 'room_disconnected'
  | 'transport_error';

export interface AudioTransport {
  /** Join the room / open the media path. Resolves once connected. */
  connect(): Promise<void>;
  /** Leave the room and release media resources. Idempotent. */
  disconnect(): Promise<void>;
  /** Register a callback for inbound (remote / principal) audio frames. */
  onRemoteAudio(cb: (frame: PcmFrame) => void): void;
  /**
   * Register a callback when the media path closes unexpectedly (principal left,
   * room disconnected). Local `disconnect()` must NOT fire this. VoiceRuntime
   * uses it to end the session when the console tab closes without DELETE.
   */
  onClose(cb: (reason: AudioTransportCloseReason) => void): void;
  /**
   * The caller's microphone was muted or unmuted by the client. iOS mutes the
   * track when the installed app is backgrounded; the peer connection stays up.
   * VoiceRuntime stops speaking and ends the call if the mute lasts the grace period.
   */
  onCallerMuted(cb: (muted: boolean) => void): void;
  /** Publish an outbound (assistant / TTS) audio frame to the remote peer. */
  publishAudio(frame: PcmFrame): Promise<void>;
  /**
   * Drop published audio that has not played yet, so a barge-in stops the
   * assistant at once instead of after the queue drains (#2379). LiveKit clears
   * its AudioSource queue; Signal restarts pacat (#2401). Optional: a transport
   * without it plays out what it already has.
   */
  clearQueuedAudio?(): void;
  /**
   * Published audio the transport still holds before playout, in ms, when it can
   * tell (#2379). LiveKit reports its AudioSource queue. The Signal pipe cannot see
   * what PulseAudio buffers past pacat, so it leaves this out.
   */
  queuedAudioMs?(): number;
}
