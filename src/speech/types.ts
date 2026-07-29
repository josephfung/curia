// types.ts — STT/TTS provider contracts for live duplex and file-shaped voice notes.
//
// Two access shapes share this module:
//   • Streaming — PCM sessions for live calls (VoiceRuntime)
//   • Batch     — finished audio files for text-channel voice notes (SpeechMediaService)
//
// Concrete providers (Deepgram, Cartesia) implement both. Channels depend down
// into src/speech/; this module never imports a channel.

// ─── Streaming (live duplex) ───────────────────────────────────────────────

export interface PcmFrame {
  pcm: Int16Array;
  sampleRate: number;
  channels: 1;
}

export interface SttTranscriptEvent {
  text: string;
  isFinal: boolean;
  /** End-of-turn / utterance endpoint signal from the provider */
  speechFinal?: boolean;
  confidence?: number;
}

export interface SttSessionOptions {
  sampleRate: number;
  language?: string;
  /** Called if the underlying connection drops */
  onError?: (err: Error) => void;
}

export interface SttSession {
  sendAudio(frame: PcmFrame): void;
  end(): Promise<void>;
  onTranscript(cb: (e: SttTranscriptEvent) => void): void;
  cancel(): void;
}

export interface SpeechToTextProvider {
  readonly id: string;
  startSession(opts: SttSessionOptions): Promise<SttSession>;
}

export interface TtsSynthesizeOptions {
  text: string;
  /** Opaque id for cancel() */
  streamId: string;
  voiceId?: string;
  sampleRate?: number;
  signal?: AbortSignal;
}

export interface TextToSpeechProvider {
  readonly id: string;
  synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame>;
  cancel(streamId: string): void;
}

// ─── Batch (finished files / voice notes) ──────────────────────────────────

/**
 * Options for one-shot (prerecorded) transcription of a finished audio file
 * — e.g. a Signal/Slack voice note. Distinct from the streaming session path.
 */
export interface TranscribeFileOptions {
  /** Raw audio bytes (any Deepgram-supported container: m4a, ogg/opus, mp3, wav, …). */
  audio: Uint8Array;
  /** Content-Type hint for the provider (e.g. `audio/mp4`, `audio/ogg`). */
  contentType?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface TranscribeFileResult {
  /**
   * Recognized transcript. An empty string is a **valid success** — the provider
   * returned no speech (silence, noise, or unintelligible audio). Callers must
   * treat `""` as "nothing recognized", not as a transport failure.
   */
  text: string;
  confidence?: number;
  /** Audio duration reported by the provider, when available. */
  durationSeconds?: number;
}

/**
 * Batch STT entry point alongside {@link SpeechToTextProvider}'s streaming session.
 * Implementations may also implement the streaming interface (Deepgram does both).
 */
export interface BatchSpeechToTextProvider {
  readonly id: string;
  transcribeFile(opts: TranscribeFileOptions): Promise<TranscribeFileResult>;
}

/**
 * Encoded audio containers for voice-note / file delivery.
 *
 * Cartesia's bytes API natively emits `mp3` and `wav` (plus raw PCM for the
 * duplex path). Signal attachments and Slack uploads both accept these;
 * native Signal voice-bubble AAC/`.m4a` can be layered later if needed.
 */
export type AudioFileFormat = 'mp3' | 'wav';

/** MIME types for {@link AudioFileFormat} — shared by Cartesia + fakes. */
export const AUDIO_FILE_CONTENT_TYPE: Record<AudioFileFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/**
 * Default bound for batch STT/TTS HTTP calls when the caller omits a signal.
 * Prevents a stalled upstream from hanging the channel adapter indefinitely.
 */
export const BATCH_REQUEST_TIMEOUT_MS = 60_000;

/** Caller signal if present, otherwise (or also) a default timeout. */
export function resolveBatchSignal(
  caller?: AbortSignal,
  timeoutMs: number = BATCH_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

export interface SynthesizeToFileOptions {
  text: string;
  format: AudioFileFormat;
  voiceId?: string;
  sampleRate?: number;
  /** Required by Cartesia for `mp3` (e.g. 128000). Ignored for `wav`. */
  bitRate?: number;
  signal?: AbortSignal;
}

export interface SynthesizeToFileResult {
  bytes: Uint8Array;
  format: AudioFileFormat;
  contentType: string;
  sampleRate: number;
}

/**
 * Batch TTS entry point alongside {@link TextToSpeechProvider}'s streaming PCM.
 * Implementations may also implement the streaming interface (Cartesia does both).
 */
export interface BatchTextToSpeechProvider {
  readonly id: string;
  synthesizeToFile(opts: SynthesizeToFileOptions): Promise<SynthesizeToFileResult>;
}

// ─── Structured HTTP errors ────────────────────────────────────────────────

/**
 * Structured HTTP failure from a speech provider. Exposes both `status` (for
 * `classifyError`, which reads `err.status`) and `statusCode` (for existing
 * voice-runtime / test assertions).
 */
export class SpeechHttpError extends Error {
  readonly statusCode: number;
  /** Alias of `statusCode` so `classifyError` can see the HTTP status. */
  readonly status: number;

  constructor(statusCode: number, message?: string) {
    super(message ?? `Speech request failed with HTTP ${statusCode}`);
    this.name = 'SpeechHttpError';
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

/** STT-flavoured {@link SpeechHttpError} (Deepgram prerecorded / streaming). */
export class SttHttpError extends SpeechHttpError {
  constructor(statusCode: number, message?: string) {
    super(statusCode, message ?? `STT request failed with HTTP ${statusCode}`);
    this.name = 'SttHttpError';
  }
}

/** TTS-flavoured {@link SpeechHttpError} (Cartesia). */
export class TtsHttpError extends SpeechHttpError {
  constructor(statusCode: number, message?: string) {
    super(statusCode, message ?? `TTS request failed with HTTP ${statusCode}`);
    this.name = 'TtsHttpError';
  }
}
