import { describe, expect, it } from 'vitest';
import type {
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttTranscriptEvent,
  TextToSpeechProvider,
} from './types.js';

describe('speech provider types', () => {
  it('are structural and do not require concrete provider classes', async () => {
    const frame: PcmFrame = {
      pcm: new Int16Array([1, -1]),
      sampleRate: 16000,
      channels: 1,
    };

    const events: SttTranscriptEvent[] = [];
    const session: SttSession = {
      sendAudio(sentFrame) {
        expect(sentFrame).toBe(frame);
      },
      async end() {},
      onTranscript(cb) {
        cb({ text: 'hello', isFinal: true, speechFinal: true, confidence: 0.9 });
      },
      cancel() {},
    };

    const stt: SpeechToTextProvider = {
      id: 'structural-stt',
      async startSession() {
        return session;
      },
    };

    const tts: TextToSpeechProvider = {
      id: 'structural-tts',
      async *synthesize() {
        yield frame;
      },
      cancel() {},
    };

    const started = await stt.startSession({ sampleRate: 16000 });
    started.onTranscript(event => events.push(event));
    started.sendAudio(frame);

    const frames: PcmFrame[] = [];
    for await (const synthesized of tts.synthesize({ text: 'hello', streamId: 's1' })) {
      frames.push(synthesized);
    }

    expect(events).toEqual([{ text: 'hello', isFinal: true, speechFinal: true, confidence: 0.9 }]);
    expect(frames).toEqual([frame]);
  });
});
