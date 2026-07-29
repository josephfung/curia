// media-service.ts — batch STT / TTS-to-file for text-channel voice notes.
//
// Wraps BatchSpeechToTextProvider / BatchTextToSpeechProvider so Signal/Slack
// (and other channel adapters) can transcribe inbound audio and synthesize
// outbound voice notes without importing VoiceRuntime or duplex session code.
//
// Streaming STT/TTS for live calls uses the same providers via their streaming
// interfaces; this service is the file-shaped entry point (#1597). Failures
// return AgentError via classifyError — never silently drop.

import type { Logger } from '../logger.js';
import type { AgentError } from '../errors/types.js';
import { classifyError } from '../errors/classify.js';
import {
  type AudioFileFormat,
  type BatchSpeechToTextProvider,
  type BatchTextToSpeechProvider,
  type SynthesizeToFileResult,
  type TranscribeFileResult,
} from './types.js';

export type { AudioFileFormat, SynthesizeToFileResult, TranscribeFileResult };

export type SpeechMediaOk<T> = { ok: true; value: T };
export type SpeechMediaErr = { ok: false; error: AgentError };
export type SpeechMediaResult<T> = SpeechMediaOk<T> | SpeechMediaErr;

export interface SpeechMediaTranscribeOptions {
  audio: Uint8Array;
  contentType?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface SpeechMediaSynthesizeOptions {
  text: string;
  format: AudioFileFormat;
  voiceId?: string;
  sampleRate?: number;
  bitRate?: number;
  signal?: AbortSignal;
}

export interface SpeechMediaServiceConfig {
  stt: BatchSpeechToTextProvider;
  tts: BatchTextToSpeechProvider;
  logger: Logger;
}

/**
 * Channel-facing facade for batch speech I/O.
 *
 * Reachable from Signal/Slack adapters without importing voice-runtime
 * internals — inject this service at wiring time (see `src/index.ts`).
 *
 * Empty transcripts (`text: ""`) are returned as `{ ok: true }` — that means
 * the provider recognized no speech, not that the call failed.
 */
export class SpeechMediaService {
  private readonly stt: BatchSpeechToTextProvider;
  private readonly tts: BatchTextToSpeechProvider;
  private readonly logger: Logger;

  constructor(config: SpeechMediaServiceConfig) {
    this.stt = config.stt;
    this.tts = config.tts;
    this.logger = config.logger.child({ component: 'speech-media' });
  }

  /** Transcribe a finished audio file → text. */
  async transcribe(opts: SpeechMediaTranscribeOptions): Promise<SpeechMediaResult<TranscribeFileResult>> {
    try {
      const value = await this.stt.transcribeFile({
        audio: opts.audio,
        contentType: opts.contentType,
        language: opts.language,
        signal: opts.signal,
      });
      return { ok: true, value };
    } catch (err) {
      const error = classifyError(err, `stt:${this.stt.id}`);
      this.logger.warn(
        { err, errorType: error.type, status: error.context.status },
        'speech media transcription failed',
      );
      return { ok: false, error };
    }
  }

  /** Synthesize text → an encoded audio file (mp3/wav). */
  async synthesize(opts: SpeechMediaSynthesizeOptions): Promise<SpeechMediaResult<SynthesizeToFileResult>> {
    try {
      const value = await this.tts.synthesizeToFile({
        text: opts.text,
        format: opts.format,
        voiceId: opts.voiceId,
        sampleRate: opts.sampleRate,
        bitRate: opts.bitRate,
        signal: opts.signal,
      });
      return { ok: true, value };
    } catch (err) {
      const error = classifyError(err, `tts:${this.tts.id}`);
      this.logger.warn(
        { err, errorType: error.type, status: error.context.status, format: opts.format },
        'speech media synthesis failed',
      );
      return { ok: false, error };
    }
  }
}
