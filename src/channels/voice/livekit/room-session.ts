// room-session.ts — AudioTransport backed by a self-hosted LiveKit room.
//
// This is the ONLY file that touches @livekit/rtc-node. The native addon is
// loaded lazily via dynamic import() inside connect(), so that:
//   - unit tests (which use FakeAudioTransport) never load native code, and
//   - a deploy missing the prebuilt binary fails with a clear runtime error at
//     connect() rather than at process import.
//
// The agent joins the same room as the console (which publishes the principal's
// mic). Inbound (principal) audio is delivered as PcmFrame at inboundSampleRate
// (default 16k — LiveKit resamples internally, matching the Deepgram STT rate).
// Outbound (assistant / TTS) audio is captured to an AudioSource at
// publishSampleRate (default 24k — Cartesia's default output). VoiceRuntime
// reads these two rates and configures STT / TTS to match, so no resampling is
// needed in this process.
//
// Disconnect: ParticipantDisconnected(principal) and Room Disconnected fire
// onClose so VoiceRuntime can end the session when the console tab closes
// without DELETE. Local disconnect() does not fire onClose.

import type { Logger } from '../../../logger.js';
import type { AudioTransport, AudioTransportCloseReason } from '../audio-transport.js';
import type { PcmFrame } from '../../../speech/index.js';
// Type-only imports are erased at compile time and never load the native addon.
import type {
  AudioFrame,
  AudioSource as LkAudioSource,
  LocalAudioTrack as LkLocalAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  Room as LkRoom,
} from '@livekit/rtc-node';

/** The LiveKit npm module shape we consume, resolved at runtime via dynamic import. */
type RtcModule = typeof import('@livekit/rtc-node');

/** Console principal identity minted by VoiceAdapter.createSession. */
const PRINCIPAL_IDENTITY = 'principal';

export interface LiveKitRoomSessionConfig {
  /** LiveKit WebSocket URL (wss://…). */
  url: string;
  /** Agent participant JWT (mint with identity 'curia-agent'). */
  token: string;
  logger: Logger;
  /** Inbound (remote → STT) sample rate. Default 16000 (Deepgram-friendly). */
  inboundSampleRate?: number;
  /** Outbound (TTS → publish) sample rate. Default 24000 (Cartesia default). */
  publishSampleRate?: number;
}

const DEFAULT_INBOUND_SAMPLE_RATE = 16000;
const DEFAULT_PUBLISH_SAMPLE_RATE = 24000;

export class LiveKitRoomSession implements AudioTransport {
  readonly inboundSampleRate: number;
  readonly publishSampleRate: number;

  private readonly log: Logger;
  private rtc: RtcModule | null = null;
  private room: LkRoom | null = null;
  private source: LkAudioSource | null = null;
  private localTrack: LkLocalAudioTrack | null = null;
  private readonly readers = new Set<ReadableStreamDefaultReader<AudioFrame>>();
  private readonly remoteCallbacks: Array<(frame: PcmFrame) => void> = [];
  private readonly closeCallbacks: Array<(reason: AudioTransportCloseReason) => void> = [];
  private connected = false;
  private disconnecting = false;
  private closeEmitted = false;

  constructor(private readonly config: LiveKitRoomSessionConfig) {
    this.log = config.logger.child({ component: 'livekit-room-session' });
    this.inboundSampleRate = config.inboundSampleRate ?? DEFAULT_INBOUND_SAMPLE_RATE;
    this.publishSampleRate = config.publishSampleRate ?? DEFAULT_PUBLISH_SAMPLE_RATE;
  }

  private async loadRtc(): Promise<RtcModule> {
    if (this.rtc) return this.rtc;
    try {
      this.rtc = await import('@livekit/rtc-node');
      return this.rtc;
    } catch (err) {
      throw new Error(
        `LiveKit RTC native module (@livekit/rtc-node) failed to load — voice transport is unavailable in this environment. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private emitClose(reason: AudioTransportCloseReason): void {
    // Local disconnect() sets disconnecting first — never notify VoiceRuntime of
    // our own teardown, or we'd recurse into endSession.
    if (this.disconnecting || this.closeEmitted) return;
    this.closeEmitted = true;
    for (const cb of this.closeCallbacks) {
      try {
        cb(reason);
      } catch (err) {
        this.log.warn({ err, reason }, 'audio transport onClose callback threw');
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const rtc = await this.loadRtc();

    const room = new rtc.Room();
    this.room = room;

    try {
      room.on(rtc.RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
        this.startConsuming(rtc, track);
      });

      // Principal closed the console tab / lost WebRTC — tear the Curia session down
      // so we don't leave STT sockets and an `active` voice_sessions row behind.
      room.on(rtc.RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        if (participant.identity === PRINCIPAL_IDENTITY) {
          this.log.info({ identity: participant.identity }, 'Principal left LiveKit room');
          this.emitClose('principal_disconnected');
        }
      });

      room.on(rtc.RoomEvent.Disconnected, () => {
        this.emitClose('room_disconnected');
      });

      await room.connect(this.config.url, this.config.token, {
        autoSubscribe: true,
        dynacast: false,
      });

      // Publish the assistant's audio track from an AudioSource we capture into.
      const source = new rtc.AudioSource(this.publishSampleRate, 1);
      this.source = source;
      const track = rtc.LocalAudioTrack.createAudioTrack('curia-agent-voice', source);
      this.localTrack = track;
      await room.localParticipant?.publishTrack(
        track,
        new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }),
      );

      this.connected = true;
      this.log.info(
        { inboundSampleRate: this.inboundSampleRate, publishSampleRate: this.publishSampleRate },
        'LiveKit room connected; agent audio track published',
      );
    } catch (err) {
      // Roll back any partially allocated native resources before surfacing the
      // failure — otherwise a rejected connect/publish leaves a room/source/track
      // pinned for the lifetime of this LiveKitRoomSession instance.
      try {
        await this.disconnect();
      } catch (cleanupErr) {
        this.log.warn({ err: cleanupErr }, 'error rolling back LiveKit connect failure');
      }
      throw err;
    }
  }

  private startConsuming(rtc: RtcModule, track: RemoteTrack): void {
    const stream = new rtc.AudioStream(track, {
      sampleRate: this.inboundSampleRate,
      numChannels: 1,
    });
    // Use an explicit reader (not for-await) so disconnect() can cancel it even
    // when no further frames arrive — cancelling a for-await-locked stream throws.
    const reader = stream.getReader();
    this.readers.add(reader);

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.disconnecting || !value) break;
          const pcm: PcmFrame = {
            pcm: value.data,
            sampleRate: value.sampleRate,
            channels: 1,
          };
          for (const cb of this.remoteCallbacks) {
            try {
              cb(pcm);
            } catch (err) {
              this.log.warn({ err }, 'remote audio callback threw');
            }
          }
        }
      } catch (err) {
        if (!this.disconnecting) {
          this.log.warn({ err }, 'LiveKit audio stream ended with error');
        }
      } finally {
        try {
          reader.releaseLock();
        } catch (err) {
          this.log.debug({ err }, 'audio stream reader lock was already released');
        }
        this.readers.delete(reader);
      }
    })();
  }

  onRemoteAudio(cb: (frame: PcmFrame) => void): void {
    this.remoteCallbacks.push(cb);
  }

  onClose(cb: (reason: AudioTransportCloseReason) => void): void {
    this.closeCallbacks.push(cb);
  }

  async publishAudio(frame: PcmFrame): Promise<void> {
    const rtc = this.rtc;
    const source = this.source;
    if (!rtc || !source || !this.connected) return;

    // The AudioSource was created at publishSampleRate; TTS is configured to emit
    // at the same rate (VoiceRuntime reads publishSampleRate), so no resampling.
    const audioFrame = new rtc.AudioFrame(
      frame.pcm,
      frame.sampleRate,
      1,
      frame.pcm.length,
    );
    await source.captureFrame(audioFrame);
  }

  async disconnect(): Promise<void> {
    if (this.disconnecting) return;
    this.disconnecting = true;
    this.connected = false;

    for (const reader of this.readers) {
      try {
        await reader.cancel();
      } catch (err) {
        this.log.debug({ err }, 'error cancelling audio stream reader');
      }
    }
    this.readers.clear();

    try {
      await this.localTrack?.close();
    } catch (err) {
      this.log.debug({ err }, 'error closing local track');
    }
    try {
      await this.source?.close();
    } catch (err) {
      this.log.debug({ err }, 'error closing audio source');
    }
    try {
      await this.room?.disconnect();
    } catch (err) {
      this.log.debug({ err }, 'error disconnecting room');
    }

    this.room = null;
    this.source = null;
    this.localTrack = null;
    this.log.info('LiveKit room disconnected');
  }
}
