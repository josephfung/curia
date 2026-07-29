// Public surface for the speech capability module (STT/TTS).
// Channels import from `../../speech/index.js` (or `../speech/index.js`) —
// never deep-reach individual files from outside this package when avoidable.

export type {
  AudioFileFormat,
  BatchSpeechToTextProvider,
  BatchTextToSpeechProvider,
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttSessionOptions,
  SttTranscriptEvent,
  SynthesizeToFileOptions,
  SynthesizeToFileResult,
  TextToSpeechProvider,
  TranscribeFileOptions,
  TranscribeFileResult,
  TtsSynthesizeOptions,
} from './types.js';

export {
  AUDIO_FILE_CONTENT_TYPE,
  BATCH_REQUEST_TIMEOUT_MS,
  resolveBatchSignal,
  SpeechHttpError,
  SttHttpError,
  TtsHttpError,
} from './types.js';

export { DeepgramSttProvider } from './deepgram-stt.js';
export { CartesiaTtsProvider } from './cartesia-tts.js';
export { FakeSttProvider, FakeSttSession } from './fake-stt.js';
export type { FakeSttProviderOptions } from './fake-stt.js';
export { FakeTtsProvider } from './fake-tts.js';
export type { FakeTtsProviderOptions } from './fake-tts.js';

export {
  SpeechMediaService,
} from './media-service.js';
export type {
  SpeechMediaErr,
  SpeechMediaOk,
  SpeechMediaResult,
  SpeechMediaServiceConfig,
  SpeechMediaSynthesizeOptions,
  SpeechMediaTranscribeOptions,
} from './media-service.js';
