// fake-audio-transport.ts — in-memory AudioTransport for unit tests.
//
// Records published (assistant) frames and lets a test drive inbound (remote)
// audio via emitRemoteAudio(). No LiveKit / native code is loaded.

import type { AudioTransport, AudioTransportCloseReason } from './audio-transport.js';
import type { PcmFrame } from './speech/types.js';

export class FakeAudioTransport implements AudioTransport {
  readonly publishedFrames: PcmFrame[] = [];
  connected = false;
  disconnectCount = 0;

  private readonly remoteCallbacks: Array<(frame: PcmFrame) => void> = [];
  private readonly closeCallbacks: Array<(reason: AudioTransportCloseReason) => void> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCount += 1;
  }

  onRemoteAudio(cb: (frame: PcmFrame) => void): void {
    this.remoteCallbacks.push(cb);
  }

  onClose(cb: (reason: AudioTransportCloseReason) => void): void {
    this.closeCallbacks.push(cb);
  }

  async publishAudio(frame: PcmFrame): Promise<void> {
    this.publishedFrames.push(frame);
  }

  /** Test helper: simulate an inbound audio frame arriving from the principal. */
  emitRemoteAudio(frame: PcmFrame): void {
    for (const cb of this.remoteCallbacks) cb(frame);
  }

  /** Test helper: simulate principal/room disconnect (must not be used from disconnect()). */
  emitClose(reason: AudioTransportCloseReason = 'principal_disconnected'): void {
    for (const cb of this.closeCallbacks) cb(reason);
  }
}
