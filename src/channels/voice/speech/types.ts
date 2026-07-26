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

/**
 * Structured HTTP failure from a TTS provider. Prefer this over embedding the
 * status in `Error.message` so callers can classify without string matching.
 */
export class TtsHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message?: string) {
    super(message ?? `TTS request failed with HTTP ${statusCode}`);
    this.name = 'TtsHttpError';
    this.statusCode = statusCode;
  }
}
