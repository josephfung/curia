// Build STT fixtures for the #2469 harness, outside the repo (FIXTURES_DIR).
//
//   pnpm exec tsx scripts/spikes/local-speech/make-fixtures.ts
//
// Sources, each rendered at 16 kHz (web voice) and 48 kHz (Signal calls):
//   • synthetic — sentences.json `stt` read by macOS `say` voices (six accents)
//     and by local TTS voices from the speech service (Kokoro, Pocket);
//     two voices per sentence.
//   • librispeech — LIBRISPEECH_N utterances of LibriSpeech test-clean (real
//     read speech, CC BY 4.0), decoded with the service image's ffmpeg.
//   • recorded — RECORDED_DIR/<id>.{wav,m4a,mp3,ogg}, the maintainer's own reading of the
//     sentence set, when present (see README "Recording fixtures").
//
// Each clip gets LEAD_MS of lead-in and TAIL_MS of tail at a NOISE_DBFS noise
// floor. The manifest records where speech starts and ends, so the runner can
// time onset → interim and end of speech → speechFinal.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { padWithNoise, readWav, speechSpan, writeWav, type Wav } from './audio.js';

const HERE = import.meta.dirname;
const FIXTURES_DIR = process.env['FIXTURES_DIR'] ?? join(HERE, '../../../../../scratch/local-speech/fixtures');
const SERVICE_TTS = process.env['FIXTURE_TTS_URL'] ?? 'http://127.0.0.1:8702';
const SERVICE_POCKET = process.env['FIXTURE_POCKET_URL'] ?? 'http://127.0.0.1:8701';
const LIBRISPEECH_DIR = process.env['LIBRISPEECH_DIR'] ?? join(HERE, '../../../../../scratch/local-speech/librispeech/LibriSpeech/test-clean');
const RECORDED_DIR = process.env['RECORDED_DIR'];
const LIBRISPEECH_N = Number(process.env['LIBRISPEECH_N'] ?? 20);
const LEAD_MS = 700;
const TAIL_MS = 1800;
const NOISE_DBFS = -60;
const RATES = [16000, 48000] as const;

interface SentenceFile {
  stt: Array<{ id: string; text: string; entities: string[] }>;
}

export interface Fixture {
  id: string;
  source: 'synthetic' | 'librispeech' | 'recorded';
  voice: string;
  text: string;
  entities: string[];
  /** Per sample rate: file name and speech span in ms from the start of the file. */
  files: Record<string, { file: string; onsetMs: number; endMs: number; durationMs: number }>;
}

type Voice = { name: string; render: (text: string, rate: number) => Promise<Wav> };

const sayVoice = (name: string): Voice => ({
  name: `say:${name}`,
  render: async (text, rate) => {
    const out = join(FIXTURES_DIR, '.tmp-say.wav');
    execFileSync('say', ['-v', name, '-o', out, '--file-format=WAVE', `--data-format=LEI16@${rate}`, text]);
    return readWav(out);
  },
});

const serviceVoice = (engine: string, voice: string | undefined, base: string): Voice => ({
  name: `${engine}${voice ? `:${voice}` : ''}`,
  render: async (text, rate) => {
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine, text, voice, sample_rate: rate }),
    });
    if (!res.ok) throw new Error(`${engine} TTS HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { sampleRate: rate, pcm: new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2)) };
  },
});

const VOICES: Voice[] = [
  sayVoice('Samantha'), // en_US
  sayVoice('Daniel'), // en_GB
  sayVoice('Karen'), // en_AU
  sayVoice('Moira'), // en_IE
  sayVoice('Rishi'), // en_IN
  sayVoice('Tessa'), // en_ZA
  serviceVoice('kokoro', undefined, SERVICE_TTS),
  serviceVoice('pocket', 'bria', SERVICE_POCKET),
  serviceVoice('pocket', 'loona', SERVICE_POCKET),
];

function place(fx: Fixture, rate: number, raw: Wav, seed: number): void {
  const span = speechSpan(raw);
  // Trim the engine's own leading/trailing silence so LEAD/TAIL are exact.
  const trimmed: Wav = {
    sampleRate: raw.sampleRate,
    pcm: raw.pcm.slice(Math.round((span.onsetMs * raw.sampleRate) / 1000), Math.round((span.endMs * raw.sampleRate) / 1000)),
  };
  const padded = padWithNoise(trimmed, LEAD_MS, TAIL_MS, NOISE_DBFS, seed);
  const file = `${rate}/${fx.id}.wav`;
  writeWav(join(FIXTURES_DIR, file), padded);
  fx.files[String(rate)] = {
    file,
    onsetMs: LEAD_MS,
    endMs: LEAD_MS + Math.round((trimmed.pcm.length * 1000) / rate),
    durationMs: Math.round((padded.pcm.length * 1000) / rate),
  };
}

function decodeWithFfmpeg(src: string, rate: number): Wav {
  const out = join(FIXTURES_DIR, '.tmp-ffmpeg.wav');
  execFileSync('docker', [
    'run', '--rm', '-v', `${src}:/in:ro`, '-v', `${FIXTURES_DIR}:/out`, '--entrypoint', 'ffmpeg', 'curia-speech:sherpa',
    '-hide_banner', '-loglevel', 'error', '-y', '-i', '/in', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', '/out/.tmp-ffmpeg.wav',
  ]);
  return readWav(out);
}

function librispeechPicks(): Array<{ id: string; path: string; text: string }> {
  if (!existsSync(LIBRISPEECH_DIR)) return [];
  const picks: Array<{ id: string; path: string; text: string }> = [];
  // One utterance per speaker, in directory order, 6–14 words long: conversational length.
  for (const spk of readdirSync(LIBRISPEECH_DIR).sort()) {
    const chapter = readdirSync(join(LIBRISPEECH_DIR, spk)).sort()[0]!;
    const dir = join(LIBRISPEECH_DIR, spk, chapter);
    const trans = readFileSync(join(dir, `${spk}-${chapter}.trans.txt`), 'utf8').trim().split('\n');
    const line = trans.find(l => {
      const n = l.split(' ').length - 1;
      return n >= 6 && n <= 14;
    });
    if (!line) continue;
    const [uttId, ...words] = line.split(' ');
    picks.push({ id: `ls-${uttId}`, path: join(dir, `${uttId}.flac`), text: words.join(' ').toLowerCase() });
    if (picks.length >= LIBRISPEECH_N) break;
  }
  return picks;
}

async function main(): Promise<void> {
  for (const r of RATES) mkdirSync(join(FIXTURES_DIR, String(r)), { recursive: true });
  const sentences = JSON.parse(readFileSync(join(HERE, 'sentences.json'), 'utf8')) as SentenceFile;
  let fixtures: Fixture[] = [];
  let seed = 1;
  // RECORDED_ONLY=1: keep the existing synthetic and LibriSpeech fixtures and
  // (re)build only the recorded ones — no `say` or TTS service needed.
  const recordedOnly = process.env['RECORDED_ONLY'] === '1';
  if (recordedOnly) {
    const existing = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as { fixtures: Fixture[] };
    fixtures = existing.fixtures.filter(f => f.source !== 'recorded');
    seed = 10_000;
  }

  for (const [i, s] of (recordedOnly ? [] : sentences.stt).entries()) {
    for (const k of [0, 1]) {
      const voice = VOICES[(i * 2 + k) % VOICES.length]!;
      const fx: Fixture = { id: `${s.id}-${voice.name.replace(/[^a-z0-9]+/gi, '_')}`, source: 'synthetic', voice: voice.name, text: s.text, entities: s.entities, files: {} };
      for (const rate of RATES) place(fx, rate, await voice.render(s.text, rate), seed);
      seed += 1;
      fixtures.push(fx);
      process.stdout.write('.');
    }
  }

  for (const ls of recordedOnly ? [] : librispeechPicks()) {
    const fx: Fixture = { id: ls.id, source: 'librispeech', voice: 'librispeech', text: ls.text, entities: [], files: {} };
    for (const rate of RATES) place(fx, rate, decodeWithFfmpeg(ls.path, rate), seed);
    seed += 1;
    fixtures.push(fx);
    process.stdout.write('l');
  }

  if (RECORDED_DIR && existsSync(RECORDED_DIR)) {
    for (const s of sentences.stt) {
      // Any container ffmpeg reads: a phone's voice memo (.m4a) works as is.
      const src = ['wav', 'm4a', 'mp3', 'ogg', 'aac', 'caf'].map(ext => join(RECORDED_DIR, `${s.id}.${ext}`)).find(p => existsSync(p));
      if (!src) continue;
      const fx: Fixture = { id: `${s.id}-recorded`, source: 'recorded', voice: 'maintainer', text: s.text, entities: s.entities, files: {} };
      for (const rate of RATES) place(fx, rate, decodeWithFfmpeg(src, rate), seed);
      seed += 1;
      fixtures.push(fx);
      process.stdout.write('r');
    }
  }

  writeFileSync(join(FIXTURES_DIR, 'manifest.json'), JSON.stringify({ leadMs: LEAD_MS, tailMs: TAIL_MS, noiseDbfs: NOISE_DBFS, fixtures }, null, 2));
  process.stdout.write(`\n${fixtures.length} fixtures → ${FIXTURES_DIR}\n`);
}

await main();
