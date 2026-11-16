// STT half of the #2469 harness: stream fixtures in real time as 20 ms frames
// through a SpeechToTextProvider and time the events VoiceRuntime depends on.
//
//   STT=local:moonshine-small STT_URL=http://127.0.0.1:8702 RATE=16000 \
//     pnpm exec tsx scripts/spikes/local-speech/run-stt.ts
//   STT=deepgram DEEPGRAM_API_KEY=… RATE=48000 pnpm exec tsx scripts/spikes/local-speech/run-stt.ts
//   MODE=batch STT=local:parakeet …          # voice-note path: whole file, no streaming
//
// Metrics per fixture (ms of wall clock, which tracks stream audio because
// frames are paced in real time):
//   onset→speechStarted   SttSpeechStartedEvent arrival − true speech onset
//   onset→bargeInInterim  first transcript passing VoiceRuntime's barge-in gate
//                         (≥3 chars, confidence ≥0.4 when given) − onset
//   end→speechFinal       first speechFinal at or after true end of speech − end
//   lastWordErrMs         (arrival − speechEndedAgoMs) − true end: timing-field accuracy
// Text: the isFinal segments joined, as VoiceRuntime builds an utterance.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { DeepgramSttProvider } from '../../../src/speech/deepgram-stt.js';
import type { BatchSpeechToTextProvider, SpeechToTextProvider, SttTranscriptEvent } from '../../../src/speech/types.js';
import { readWav, wavBytes, percentile } from './audio.js';
import { LocalSttProvider } from './local-providers.js';
import { canonical, entityHeard, wordErrors } from './scoring.js';
import type { Fixture } from './make-fixtures.js';

const HERE = import.meta.dirname;
const FIXTURES_DIR = process.env['FIXTURES_DIR'] ?? join(HERE, '../../../../../scratch/local-speech/fixtures');
const RESULTS_DIR = process.env['RESULTS_DIR'] ?? join(HERE, 'results');
const STT = process.env['STT'] ?? 'local:moonshine-small';
const STT_URL = process.env['STT_URL'] ?? 'http://127.0.0.1:8702';
const RATE = Number(process.env['RATE'] ?? 16000);
const MODE = process.env['MODE'] ?? 'stream';
const HOST = process.env['HOST_LABEL'] ?? 'local';
const ONLY = process.env['ONLY'] ? new RegExp(process.env['ONLY']) : undefined;
const LIMIT = Number(process.env['LIMIT'] ?? 0);
const FRAME_MS = 20;
const BARGE_IN_MIN_CHARS = 3;
const BARGE_IN_MIN_CONFIDENCE = 0.4;

const logger = pino({ level: 'warn' });

function provider(): SpeechToTextProvider & BatchSpeechToTextProvider {
  if (STT === 'deepgram') {
    const key = process.env['DEEPGRAM_API_KEY'];
    if (!key) throw new Error('DEEPGRAM_API_KEY is required for STT=deepgram');
    return new DeepgramSttProvider(key, logger);
  }
  if (STT.startsWith('local:')) return new LocalSttProvider({ baseUrl: STT_URL, engine: STT.slice('local:'.length) });
  throw new Error(`unknown STT ${STT}`);
}

interface TimedEvent {
  atMs: number;
  kind: 'speechStarted' | 'transcript';
  text?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  confidence?: number;
  speechStartedAgoMs?: number;
  speechEndedAgoMs?: number;
}

export interface SttFixtureResult {
  id: string;
  source: Fixture['source'];
  voice: string;
  ref: string;
  hyp: string;
  refWords: number;
  wordErrors: number;
  entities: Array<{ entity: string; heard: boolean }>;
  onsetToSpeechStartedMs: number | null;
  onsetToBargeInInterimMs: number | null;
  endToSpeechFinalMs: number | null;
  earlySpeechFinals: number;
  interims: number;
  lastWordErrMs: number | null;
  firstWordErrMs: number | null;
  events?: TimedEvent[];
  serverStats?: Record<string, number>;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, Math.max(0, ms)));

async function streamOne(p: SpeechToTextProvider, fx: Fixture): Promise<SttFixtureResult> {
  const meta = fx.files[String(RATE)]!;
  const wav = readWav(join(FIXTURES_DIR, meta.file));
  const events: TimedEvent[] = [];
  let t0 = 0;
  let error: string | undefined;
  const session = await p.startSession({ sampleRate: RATE, language: 'en', onError: err => { error = err.message; } });
  session.onTranscript((e: SttTranscriptEvent) => {
    events.push({ atMs: performance.now() - t0, kind: 'transcript', text: e.text, isFinal: e.isFinal, speechFinal: e.speechFinal,
      confidence: e.confidence, speechStartedAgoMs: e.speechStartedAgoMs, speechEndedAgoMs: e.speechEndedAgoMs });
  });
  session.onSpeechStarted?.(e => {
    events.push({ atMs: performance.now() - t0, kind: 'speechStarted', speechStartedAgoMs: e.startedAgoMs });
  });

  const samplesPerFrame = (RATE * FRAME_MS) / 1000;
  t0 = performance.now();
  for (let i = 0, f = 0; i < wav.pcm.length; i += samplesPerFrame, f += 1) {
    // Pace against the start time, not the previous frame, so timer jitter does not accumulate.
    await sleep(t0 + f * FRAME_MS - performance.now());
    session.sendAudio({ pcm: wav.pcm.slice(i, i + samplesPerFrame), sampleRate: RATE, channels: 1 });
  }
  const streamEndMs = performance.now() - t0;
  await session.end();
  // Local sessions report what the service did (frames, second passes, fallbacks).
  const serverStats = (session as { serverStats?: Record<string, number> }).serverStats;

  const live = events.filter(e => e.atMs <= streamEndMs + 50);
  const speechStarted = live.find(e => e.kind === 'speechStarted' && e.atMs >= meta.onsetMs - 200);
  const bargeIn = live.find(e => e.kind === 'transcript' && (e.text?.trim().length ?? 0) >= BARGE_IN_MIN_CHARS
    && (e.confidence === undefined || e.confidence >= BARGE_IN_MIN_CONFIDENCE));
  const finalAfterEnd = live.find(e => e.kind === 'transcript' && e.speechFinal && e.atMs >= meta.endMs);
  const earlyFinals = live.filter(e => e.kind === 'transcript' && e.speechFinal && (e.text ?? '').length > 0 && e.atMs < meta.endMs);
  const finals = events.filter(e => e.kind === 'transcript' && e.isFinal && e.text);
  const hyp = finals.map(e => e.text!.trim()).join(' ').trim();
  const lastFinal = [...finals].reverse().find(e => e.speechEndedAgoMs !== undefined);
  const firstFinal = finals.find(e => e.speechStartedAgoMs !== undefined);

  const refTokens = canonical(fx.text);
  const hypTokens = canonical(hyp);
  return {
    id: fx.id,
    source: fx.source,
    voice: fx.voice,
    ref: fx.text,
    hyp,
    refWords: refTokens.length,
    wordErrors: wordErrors(refTokens, hypTokens),
    entities: fx.entities.map(entity => ({ entity, heard: entityHeard(entity, hypTokens) })),
    onsetToSpeechStartedMs: speechStarted ? Math.round(speechStarted.atMs - meta.onsetMs) : null,
    onsetToBargeInInterimMs: bargeIn ? Math.round(bargeIn.atMs - meta.onsetMs) : null,
    endToSpeechFinalMs: finalAfterEnd ? Math.round(finalAfterEnd.atMs - meta.endMs) : null,
    earlySpeechFinals: earlyFinals.length,
    interims: live.filter(e => e.kind === 'transcript' && !e.isFinal).length,
    lastWordErrMs: lastFinal ? Math.round(lastFinal.atMs - lastFinal.speechEndedAgoMs! - meta.endMs) : null,
    firstWordErrMs: firstFinal ? Math.round(firstFinal.atMs - firstFinal.speechStartedAgoMs! - meta.onsetMs) : null,
    events,
    ...(serverStats ? { serverStats } : {}),
    ...(error ? { error } : {}),
  };
}

async function batchOne(p: BatchSpeechToTextProvider, fx: Fixture): Promise<SttFixtureResult & { processingMs: number; audioMs: number }> {
  const meta = fx.files[String(RATE)]!;
  const wav = readWav(join(FIXTURES_DIR, meta.file));
  const t = performance.now();
  const res = await p.transcribeFile({ audio: wavBytes(wav), contentType: 'audio/wav', language: 'en' });
  const processingMs = Math.round(performance.now() - t);
  const refTokens = canonical(fx.text);
  const hypTokens = canonical(res.text);
  return {
    id: fx.id, source: fx.source, voice: fx.voice, ref: fx.text, hyp: res.text, refWords: refTokens.length,
    wordErrors: wordErrors(refTokens, hypTokens),
    entities: fx.entities.map(entity => ({ entity, heard: entityHeard(entity, hypTokens) })),
    onsetToSpeechStartedMs: null, onsetToBargeInInterimMs: null, endToSpeechFinalMs: null, earlySpeechFinals: 0,
    interims: 0, lastWordErrMs: null, firstWordErrMs: null, processingMs, audioMs: meta.durationMs,
  };
}

function summarize(results: SttFixtureResult[]): Record<string, unknown> {
  const pick = (f: (r: SttFixtureResult) => number | null): number[] => results.map(f).filter((v): v is number => v !== null);
  const stat = (vals: number[]): { p50: number | null; p95: number | null; n: number } => ({ p50: percentile(vals, 50), p95: percentile(vals, 95), n: vals.length });
  const wer = (rs: SttFixtureResult[]): number | null => {
    const words = rs.reduce((a, r) => a + r.refWords, 0);
    return words ? Math.round((rs.reduce((a, r) => a + r.wordErrors, 0) / words) * 1000) / 10 : null;
  };
  const ents = results.flatMap(r => r.entities);
  return {
    fixtures: results.length,
    werPct: wer(results),
    werPctBySource: Object.fromEntries(['synthetic', 'librispeech', 'recorded'].map(s => [s, wer(results.filter(r => r.source === s))])),
    entityAccuracyPct: ents.length ? Math.round((ents.filter(e => e.heard).length / ents.length) * 1000) / 10 : null,
    entitiesMissed: ents.filter(e => !e.heard).map(e => e.entity),
    onsetToSpeechStartedMs: stat(pick(r => r.onsetToSpeechStartedMs)),
    onsetToBargeInInterimMs: stat(pick(r => r.onsetToBargeInInterimMs)),
    endToSpeechFinalMs: stat(pick(r => r.endToSpeechFinalMs)),
    speechFinalMissing: results.filter(r => r.endToSpeechFinalMs === null).length,
    earlySpeechFinalsTotal: results.reduce((a, r) => a + r.earlySpeechFinals, 0),
    lastWordErrMs: stat(pick(r => r.lastWordErrMs).map(Math.abs)),
    firstWordErrMs: stat(pick(r => r.firstWordErrMs).map(Math.abs)),
    errors: results.filter(r => r.error).length,
  };
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as { fixtures: Fixture[] };
  let fixtures = manifest.fixtures.filter(f => !ONLY || ONLY.test(f.id));
  if (LIMIT) fixtures = fixtures.slice(0, LIMIT);
  const p = provider();
  const results: SttFixtureResult[] = [];
  for (const fx of fixtures) {
    try {
      results.push(MODE === 'batch' ? await batchOne(p, fx) : await streamOne(p, fx));
    } catch (err) {
      results.push({ id: fx.id, source: fx.source, voice: fx.voice, ref: fx.text, hyp: '', refWords: canonical(fx.text).length,
        wordErrors: canonical(fx.text).length, entities: fx.entities.map(entity => ({ entity, heard: false })),
        onsetToSpeechStartedMs: null, onsetToBargeInInterimMs: null, endToSpeechFinalMs: null, earlySpeechFinals: 0,
        interims: 0, lastWordErrMs: null, firstWordErrMs: null, error: (err as Error).message });
    }
    const r = results[results.length - 1]!;
    process.stdout.write(`${r.id.padEnd(34)} we=${r.wordErrors}/${r.refWords} onset→ss=${r.onsetToSpeechStartedMs} onset→int=${r.onsetToBargeInInterimMs} end→sf=${r.endToSpeechFinalMs}${r.error ? ` ERR ${r.error}` : ''}\n`);
  }
  const summary = summarize(results);
  if (MODE === 'batch') {
    const br = results as Array<SttFixtureResult & { processingMs: number; audioMs: number }>;
    summary['processingMs'] = { p50: percentile(br.map(r => r.processingMs), 50), p95: percentile(br.map(r => r.processingMs), 95) };
    summary['rtf'] = Math.round((br.reduce((a, r) => a + r.processingMs, 0) / br.reduce((a, r) => a + r.audioMs, 0)) * 1000) / 1000;
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  const name = `stt.${MODE}.${HOST}.${STT.replace(/[^a-z0-9.-]+/gi, '_')}.${RATE}.json`;
  writeFileSync(join(RESULTS_DIR, name), JSON.stringify({ host: HOST, stt: STT, rate: RATE, mode: MODE, at: new Date().toISOString(), summary, results }, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n→ ${join(RESULTS_DIR, name)}\n`);
}

await main();
