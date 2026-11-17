// TTS half of the #2469 harness.
//
//   TTS=local:kokoro TTS_URL=http://127.0.0.1:8702 RATE=24000 \
//     CONCURRENT_STT=local:zipformer@http://127.0.0.1:8701 \
//     pnpm exec tsx scripts/spikes/local-speech/run-tts.ts
//   TTS=cartesia CARTESIA_API_KEY=… CARTESIA_VOICE_ID=… RATE=48000 pnpm exec tsx …
//
// Per sentence (sentences.json `tts`) × REPS, through a TextToSpeechProvider:
//   ttfbMs   synthesize() call → first PcmFrame (Curia sends one request per sentence)
//   rtf      synthesis wall time / audio duration
//   stallMs  worst lateness of a chunk against real-time playback from the first
//            chunk: > 0 means the audio would run dry mid-sentence
// Cancel: start the longest sentence, cancel() CANCEL_AFTER_MS after the first
// frame, and time cancel → the iterator finishing (no frame after that is played).
// CONCURRENT_STT streams fixtures through an STT session in real time for the
// whole run, so TTS is measured with recognition running beside it, as on a call.
// The first rep of each sentence is saved to AUDIO_DIR for listening.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { CartesiaTtsProvider } from '../../../src/speech/cartesia-tts.js';
import type { TextToSpeechProvider } from '../../../src/speech/types.js';
import { percentile, readWav, writeWav } from './audio.js';
import { LocalSttProvider, LocalTtsProvider } from './local-providers.js';
import { DeepgramSttProvider } from '../../../src/speech/deepgram-stt.js';
import type { Fixture } from './make-fixtures.js';

const HERE = import.meta.dirname;
const TTS = process.env['TTS'] ?? 'local:kokoro';
const TTS_URL = process.env['TTS_URL'] ?? 'http://127.0.0.1:8702';
const RATE = Number(process.env['RATE'] ?? 24000);
const REPS = Number(process.env['REPS'] ?? 3);
const HOST = process.env['HOST_LABEL'] ?? 'local';
const CONCURRENT_STT = process.env['CONCURRENT_STT'];
const CANCEL_REPS = Number(process.env['CANCEL_REPS'] ?? 5);
const CANCEL_AFTER_MS = Number(process.env['CANCEL_AFTER_MS'] ?? 300);
const RESULTS_DIR = process.env['RESULTS_DIR'] ?? join(HERE, 'results');
const AUDIO_DIR = process.env['AUDIO_DIR'] ?? join(HERE, '../../../../../scratch/local-speech/audio');
const FIXTURES_DIR = process.env['FIXTURES_DIR'] ?? join(HERE, '../../../../../scratch/local-speech/fixtures');

const logger = pino({ level: 'warn' });

function provider(): TextToSpeechProvider {
  if (TTS === 'cartesia') {
    const key = process.env['CARTESIA_API_KEY'];
    const voice = process.env['CARTESIA_VOICE_ID'];
    if (!key || !voice) throw new Error('CARTESIA_API_KEY and CARTESIA_VOICE_ID are required for TTS=cartesia');
    return new CartesiaTtsProvider(key, logger, voice);
  }
  if (TTS.startsWith('local:')) {
    const [engine, voice] = TTS.slice('local:'.length).split('#');
    return new LocalTtsProvider({ baseUrl: TTS_URL, engine: engine!, ...(voice ? { voice } : {}) });
  }
  throw new Error(`unknown TTS ${TTS}`);
}

/** Stream fixtures through STT in real time until stopped. */
function startBackgroundStt(spec: string): { stop: () => Promise<string | undefined> } {
  const [name, url] = spec.split('@');
  const stt = name === 'deepgram'
    ? new DeepgramSttProvider(process.env['DEEPGRAM_API_KEY'] ?? '', logger)
    : new LocalSttProvider({ baseUrl: url!, engine: name!.slice('local:'.length) });
  const rate = 16000;
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as { fixtures: Fixture[] };
  let running = true;
  let failure: string | undefined;
  const loop = (async () => {
    // A dead background session would leave TTS measured with no STT load while
    // the file still says "with-stt": record the failure and stop.
    const session = await stt.startSession({ sampleRate: rate, onError: err => { failure = err.message; running = false; } });
    const t0 = performance.now();
    let frame = 0;
    for (let k = 0; running; k += 1) {
      const fx = manifest.fixtures[k % manifest.fixtures.length]!;
      const wav = readWav(join(FIXTURES_DIR, fx.files[String(rate)]!.file));
      for (let i = 0; i < wav.pcm.length && running; i += 320, frame += 1) {
        await new Promise(r => setTimeout(r, Math.max(0, t0 + frame * 20 - performance.now())));
        session.sendAudio({ pcm: wav.pcm.slice(i, i + 320), sampleRate: rate, channels: 1 });
      }
    }
    await session.end();
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return failure;
    },
  };
}

interface SentenceRun {
  id: string;
  rep: number;
  ttfbMs: number;
  totalMs: number;
  audioMs: number;
  rtf: number;
  stallMs: number;
}

async function synthOnce(p: TextToSpeechProvider, id: string, text: string, rep: number): Promise<{ run: SentenceRun; pcm: Int16Array }> {
  const t = performance.now();
  let first = 0;
  let audioSamples = 0;
  let stall = 0;
  const chunks: Int16Array[] = [];
  for await (const frame of p.synthesize({ text, streamId: `${id}-${rep}`, sampleRate: RATE })) {
    const now = performance.now() - t;
    if (!first) first = now;
    // When this chunk should start playing if playback began at the first chunk.
    const due = first + (audioSamples / frame.sampleRate) * 1000;
    stall = Math.max(stall, now - due);
    audioSamples += frame.pcm.length;
    chunks.push(frame.pcm);
  }
  const totalMs = performance.now() - t;
  if (audioSamples === 0) throw new Error(`${id}: TTS returned no audio (see the service log)`);
  const audioMs = (audioSamples / RATE) * 1000;
  const pcm = new Int16Array(audioSamples);
  let o = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  return {
    run: { id, rep, ttfbMs: Math.round(first), totalMs: Math.round(totalMs), audioMs: Math.round(audioMs), rtf: Math.round((totalMs / audioMs) * 1000) / 1000, stallMs: Math.round(stall) },
    pcm,
  };
}

async function cancelOnce(p: TextToSpeechProvider, text: string, rep: number): Promise<{ cancelToDoneMs: number; framesAfterCancel: number }> {
  const streamId = `cancel-${rep}`;
  let cancelAt = 0;
  let framesAfter = 0;
  const it = p.synthesize({ text, streamId, sampleRate: RATE });
  let timer: ReturnType<typeof setTimeout> | undefined;
  for await (const _frame of it) {
    if (cancelAt) framesAfter += 1;
    else if (!timer) {
      timer = setTimeout(() => {
        cancelAt = performance.now();
        p.cancel(streamId);
      }, CANCEL_AFTER_MS);
    }
  }
  if (!cancelAt) {
    clearTimeout(timer);
    return { cancelToDoneMs: -1, framesAfterCancel: 0 };
  }
  return { cancelToDoneMs: Math.round(performance.now() - cancelAt), framesAfterCancel: framesAfter };
}

async function serviceRss(): Promise<number | null> {
  if (!TTS.startsWith('local:')) return null;
  try {
    const h = (await (await fetch(`${TTS_URL}/health`)).json()) as { rss_mb: number };
    return h.rss_mb;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sentences = (JSON.parse(readFileSync(join(HERE, 'sentences.json'), 'utf8')) as { tts: Array<{ id: string; text: string }> }).tts;
  const p = provider();
  const label = TTS.replace(/[^a-z0-9.#-]+/gi, '_').replace('#', '-');
  const audioDir = join(AUDIO_DIR, HOST, `${label}.${RATE}`);
  mkdirSync(audioDir, { recursive: true });
  const bg = CONCURRENT_STT ? startBackgroundStt(CONCURRENT_STT) : undefined;
  if (bg) await new Promise(r => setTimeout(r, 1500));
  const rssBefore = await serviceRss();

  // Warm-up (first call loads voice caches; cold start is reported from /health load times).
  await synthOnce(p, 'warmup', 'Hello.', 0);

  const runs: SentenceRun[] = [];
  for (let rep = 0; rep < REPS; rep += 1) {
    for (const s of sentences) {
      const { run, pcm } = await synthOnce(p, s.id, s.text, rep);
      runs.push(run);
      if (rep === 0) writeWav(join(audioDir, `${s.id}.wav`), { sampleRate: RATE, pcm });
      process.stdout.write(`${s.id} rep${rep} ttfb=${run.ttfbMs} rtf=${run.rtf} stall=${run.stallMs} audio=${run.audioMs}\n`);
    }
  }

  const longest = [...sentences].sort((a, b) => b.text.length - a.text.length)[0]!;
  const cancels = [];
  for (let rep = 0; rep < CANCEL_REPS; rep += 1) cancels.push(await cancelOnce(p, longest.text, rep));
  const rssAfter = await serviceRss();
  const backgroundSttError = await bg?.stop();
  if (backgroundSttError) process.stderr.write(`background STT failed during the run: ${backgroundSttError}\n`);

  const stat = (v: number[]): { p50: number | null; p95: number | null } => ({ p50: percentile(v, 50), p95: percentile(v, 95) });
  const summary = {
    ttfbMs: stat(runs.map(r => r.ttfbMs)),
    rtf: stat(runs.map(r => r.rtf)),
    stallMs: stat(runs.map(r => r.stallMs)),
    sentencesWithStall: runs.filter(r => r.stallMs > 20).length,
    cancelToDoneMs: stat(cancels.map(c => c.cancelToDoneMs).filter(v => v >= 0)),
    framesAfterCancel: cancels.reduce((a, c) => a + c.framesAfterCancel, 0),
    serviceRssMb: { before: rssBefore, after: rssAfter },
    concurrentStt: CONCURRENT_STT ?? null,
    ...(backgroundSttError ? { backgroundSttError } : {}),
    // Client-side only: time from cancel() to the iterator ending. It does not
    // show whether the service stopped generating.
    cancelsMeasured: cancels.filter(c => c.cancelToDoneMs >= 0).length,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const name = `tts.${HOST}.${label}.${RATE}${CONCURRENT_STT ? '.with-stt' : ''}.json`;
  writeFileSync(join(RESULTS_DIR, name), JSON.stringify({ host: HOST, tts: TTS, rate: RATE, at: new Date().toISOString(), summary, runs, cancels }, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n→ ${join(RESULTS_DIR, name)}\n`);
}

await main();
