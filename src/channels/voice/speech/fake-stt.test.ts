import { describe, expect, it, vi } from 'vitest';
import { FakeSttProvider, FakeSttSession } from './fake-stt.js';

describe('FakeSttProvider', () => {
  it('records session options and audio frames', async () => {
    const provider = new FakeSttProvider();
    const session = await provider.startSession({ sampleRate: 16000, language: 'en' });
    const frame = { pcm: new Int16Array([1, 2, 3]), sampleRate: 16000, channels: 1 as const };

    session.sendAudio(frame);

    expect(provider.sessionOptions).toEqual([{ sampleRate: 16000, language: 'en' }]);
    expect(provider.sessions[0]?.audioFrames).toEqual([frame]);
  });

  it('emits transcripts to active sessions', async () => {
    const provider = new FakeSttProvider();
    const session = await provider.startSession({ sampleRate: 16000 });
    const transcriptSpy = vi.fn();

    session.onTranscript(transcriptSpy);
    provider.emit({ text: 'hello', isFinal: true, speechFinal: true });

    expect(transcriptSpy).toHaveBeenCalledWith({ text: 'hello', isFinal: true, speechFinal: true });
  });

  it('does not emit transcripts or record audio after cancel', () => {
    const session = new FakeSttSession();
    const transcriptSpy = vi.fn();
    const frame = { pcm: new Int16Array([1]), sampleRate: 16000, channels: 1 as const };

    session.onTranscript(transcriptSpy);
    session.cancel();
    session.sendAudio(frame);
    session.emit({ text: 'ignored', isFinal: false });

    expect(session.audioFrames).toEqual([]);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it('transcribeFile returns the configured transcript', async () => {
    const provider = new FakeSttProvider({
      fileTranscript: { text: 'from file', confidence: 0.5 },
    });
    const audio = new Uint8Array([1, 2]);

    await expect(provider.transcribeFile({ audio, contentType: 'audio/wav' }))
      .resolves.toEqual({ text: 'from file', confidence: 0.5 });
    expect(provider.fileRequests).toEqual([{ audio, contentType: 'audio/wav' }]);
  });
});
