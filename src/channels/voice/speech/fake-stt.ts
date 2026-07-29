import type {
  BatchSpeechToTextProvider,
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttSessionOptions,
  SttTranscriptEvent,
  TranscribeFileOptions,
  TranscribeFileResult,
} from './types.js';

export class FakeSttSession implements SttSession {
  readonly audioFrames: PcmFrame[] = [];

  private readonly transcriptCallbacks: Array<(e: SttTranscriptEvent) => void> = [];
  private ended = false;
  private cancelled = false;

  sendAudio(frame: PcmFrame): void {
    if (this.ended || this.cancelled) return;
    this.audioFrames.push(frame);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  onTranscript(cb: (e: SttTranscriptEvent) => void): void {
    this.transcriptCallbacks.push(cb);
  }

  cancel(): void {
    this.cancelled = true;
  }

  emit(event: SttTranscriptEvent): void {
    if (this.cancelled) return;
    for (const cb of this.transcriptCallbacks) {
      cb(event);
    }
  }
}

export interface FakeSttProviderOptions {
  /** Fixed transcript returned by transcribeFile. */
  fileTranscript?: TranscribeFileResult;
  /** When set, transcribeFile rejects with this error. */
  fileError?: Error;
}

export class FakeSttProvider implements SpeechToTextProvider, BatchSpeechToTextProvider {
  readonly id = 'fake-stt';
  readonly sessions: FakeSttSession[] = [];
  readonly sessionOptions: SttSessionOptions[] = [];
  readonly fileRequests: TranscribeFileOptions[] = [];

  private fileTranscript: TranscribeFileResult;
  private fileError: Error | undefined;

  constructor(opts: FakeSttProviderOptions = {}) {
    this.fileTranscript = opts.fileTranscript ?? { text: 'fake transcript', confidence: 0.99 };
    this.fileError = opts.fileError;
  }

  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    const session = new FakeSttSession();
    this.sessions.push(session);
    this.sessionOptions.push(opts);
    return session;
  }

  async transcribeFile(opts: TranscribeFileOptions): Promise<TranscribeFileResult> {
    this.fileRequests.push(opts);
    if (this.fileError) throw this.fileError;
    return this.fileTranscript;
  }

  emit(event: SttTranscriptEvent): void {
    for (const session of this.sessions) {
      session.emit(event);
    }
  }

  setFileTranscript(result: TranscribeFileResult): void {
    this.fileTranscript = result;
  }

  setFileError(err: Error | undefined): void {
    this.fileError = err;
  }
}
