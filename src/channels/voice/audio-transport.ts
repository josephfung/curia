// audio-transport.ts — the seam between VoiceRuntime and whatever carries PCM
// audio to/from the principal. Phase 1 has one real implementation
// (LiveKitRoomSession, console WebRTC) and a FakeAudioTransport for tests.
//
// Keeping this an interface lets VoiceRuntime stay transport-agnostic: Phase 2
// transports (Signal RingRTC, SIP) plug in here without touching the runtime or
// the speech providers.

import type { PcmFrame } from './speech/types.js';

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
  /** Publish an outbound (assistant / TTS) audio frame to the remote peer. */
  publishAudio(frame: PcmFrame): Promise<void>;
}
