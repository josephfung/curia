import { describe, expect, it } from 'vitest';
import type {
  BatchSpeechToTextProvider,
  BatchTextToSpeechProvider,
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

    const batchStt: BatchSpeechToTextProvider = {
      id: 'structural-batch-stt',
      async transcribeFile() {
        return { text: 'from file', confidence: 0.8 };
      },
    };

    const batchTts: BatchTextToSpeechProvider = {
      id: 'structural-batch-tts',
      async synthesizeToFile(opts) {
        return {
          bytes: new Uint8Array([1]),
          format: opts.format,
          contentType: opts.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          sampleRate: 24000,
        };
      },
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
    expect(await batchStt.transcribeFile({ audio: new Uint8Array([1]) })).toEqual({
      text: 'from file',
      confidence: 0.8,
    });
    expect(await batchTts.synthesizeToFile({ text: 'hi', format: 'wav' })).toMatchObject({
      format: 'wav',
      contentType: 'audio/wav',
    });
  });
});
