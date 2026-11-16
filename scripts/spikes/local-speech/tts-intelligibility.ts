// Round-trip check for TTS audio saved by run-tts.ts: transcribe each sentence
// with a strong batch STT (Parakeet by default) and score it against the text.
// A stand-in for listening, not a replacement: it catches dropped words and
// misread numbers, emails and names, not prosody (the "Good morning, Boss" pause).
//
//   STT_URL=http://127.0.0.1:8701 pnpm exec tsx scripts/spikes/local-speech/tts-intelligibility.ts <audio-dir> [...]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LocalSttProvider } from './local-providers.js';
import { canonical, wordErrors } from './scoring.js';

const HERE = import.meta.dirname;
const STT_URL = process.env['STT_URL'] ?? 'http://127.0.0.1:8701';
const ENGINE = process.env['STT_ENGINE'] ?? 'parakeet';
const RESULTS_DIR = process.env['RESULTS_DIR'] ?? join(HERE, 'results');
const sentences = (JSON.parse(readFileSync(join(HERE, 'sentences.json'), 'utf8')) as { tts: Array<{ id: string; text: string }> }).tts;
const stt = new LocalSttProvider({ baseUrl: STT_URL, engine: ENGINE });

const out: Record<string, unknown> = {};
for (const dir of process.argv.slice(2)) {
  let errs = 0;
  let words = 0;
  const lines: Array<{ id: string; heard: string; wordErrors: number; refWords: number }> = [];
  for (const s of sentences) {
    const path = join(dir, `${s.id}.wav`);
    // A missing take means an aborted run (or stale audio from another one): stop, don't score a subset.
    if (!existsSync(path)) throw new Error(`${path} is missing; rerun run-tts.ts for this voice`);
    const { text } = await stt.transcribeFile({ audio: readFileSync(path), contentType: 'audio/wav' });
    const ref = canonical(s.text);
    const e = wordErrors(ref, canonical(text));
    errs += e;
    words += ref.length;
    lines.push({ id: s.id, heard: text, wordErrors: e, refWords: ref.length });
  }
  const label = basename(dir);
  out[label] = { roundTripWerPct: words ? Math.round((errs / words) * 1000) / 10 : null, lines };
  process.stdout.write(`${label.padEnd(36)} round-trip WER ${words ? ((errs / words) * 100).toFixed(1) : '—'}%\n`);
  for (const l of lines.filter(x => x.wordErrors > 0)) process.stdout.write(`   ${l.id} (${l.wordErrors}) ${l.heard}\n`);
}
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, `tts-intelligibility.${process.env['HOST_LABEL'] ?? 'local'}.json`), JSON.stringify(out, null, 2));
