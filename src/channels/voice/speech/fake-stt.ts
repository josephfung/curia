import type {
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttSessionOptions,
  SttTranscriptEvent,
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

export class FakeSttProvider implements SpeechToTextProvider {
  readonly id = 'fake-stt';
  readonly sessions: FakeSttSession[] = [];
  readonly sessionOptions: SttSessionOptions[] = [];

  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    const session = new FakeSttSession();
    this.sessions.push(session);
    this.sessionOptions.push(opts);
    return session;
  }

  emit(event: SttTranscriptEvent): void {
    for (const session of this.sessions) {
      session.emit(event);
    }
  }
}
