// Aggregate results/*.json into the markdown tables RESULTS.md quotes.
//
//   pnpm exec tsx scripts/spikes/local-speech/report.ts [results-dir]

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, entityHeard, wordErrors } from './scoring.js';

const dir = process.argv[2] ?? join(import.meta.dirname, 'results');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

/** Re-score WER and entities with the current scoring.ts, so every table uses one canonicaliser. */
type Scored = { source: string; ref: string; hyp: string; refWords: number; wordErrors: number; entities: Array<{ entity: string; heard: boolean }> };
function rescore(run: { results: Scored[]; summary: Record<string, unknown> }): void {
  for (const r of run.results) {
    const ref = canonical(r.ref);
    const hyp = canonical(r.hyp);
    r.refWords = ref.length;
    r.wordErrors = wordErrors(ref, hyp);
    r.entities = r.entities.map(e => ({ entity: e.entity, heard: entityHeard(e.entity, hyp) }));
  }
  const wer = (rs: Scored[]): number | null => {
    const w = rs.reduce((a, r) => a + r.refWords, 0);
    return w ? Math.round((rs.reduce((a, r) => a + r.wordErrors, 0) / w) * 1000) / 10 : null;
  };
  const ents = run.results.flatMap(r => r.entities);
  run.summary['werPct'] = wer(run.results);
  run.summary['werPctBySource'] = Object.fromEntries(['synthetic', 'librispeech', 'recorded'].map(s => [s, wer(run.results.filter(r => r.source === s))]));
  run.summary['entityAccuracyPct'] = ents.length ? Math.round((ents.filter(e => e.heard).length / ents.length) * 1000) / 10 : null;
}
const load = <T>(f: string): T => {
  const run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { results?: Scored[]; summary: Record<string, unknown> };
  if (run.results) rescore(run as { results: Scored[]; summary: Record<string, unknown> });
  return run as T;
};

type Stat = { p50: number | null; p95: number | null; n?: number };
const fmt = (s: Stat | undefined): string => (s && s.p50 !== null ? `${s.p50} / ${s.p95}` : '—');

const stt = files.filter(f => f.startsWith('stt.stream.')).map(f => load<{
  host: string; stt: string; rate: number; summary: Record<string, unknown> & {
    werPct: number; werPctBySource: Record<string, number | null>; entityAccuracyPct: number; fixtures: number;
    onsetToSpeechStartedMs: Stat; onsetToBargeInInterimMs: Stat; endToSpeechFinalMs: Stat; speechFinalMissing: number;
    earlySpeechFinalsTotal: number; lastWordErrMs: Stat; errors: number;
  };
}>(f));
stt.sort((a, b) => a.host.localeCompare(b.host) || a.rate - b.rate || a.stt.localeCompare(b.stt));

console.log('### Streaming STT (p50 / p95, ms)\n');
console.log('| Host | Rate | Engine | n | errors | WER % (synthetic / LibriSpeech / recorded) | Entities heard % | onset → speechStarted | onset → barge-in interim | end of speech → speechFinal | speechFinal missing | early speechFinals | last-word timing error |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of stt) {
  const s = r.summary;
  const src = ['synthetic', 'librispeech', 'recorded'].map(k => s.werPctBySource[k] ?? '—').join(' / ');
  console.log(`| ${r.host} | ${r.rate / 1000}k | ${r.stt} | ${s.fixtures} | ${s.errors} | ${s.werPct} (${src}) | ${s.entityAccuracyPct} | ${fmt(s.onsetToSpeechStartedMs)} | ${fmt(s.onsetToBargeInInterimMs)} | ${fmt(s.endToSpeechFinalMs)} | ${s.speechFinalMissing} | ${s.earlySpeechFinalsTotal} | ${fmt(s.lastWordErrMs)} |`);
}

const batch = files.filter(f => f.startsWith('stt.batch.')).map(f => load<{
  host: string; stt: string; rate: number; summary: { werPct: number; werPctBySource: Record<string, number | null>; entityAccuracyPct: number; processingMs: Stat; rtf: number; fixtures: number };
}>(f));
if (batch.length) {
  console.log('\n### Voice-note (batch) STT\n');
  console.log('| Host | Engine | n | WER % (synthetic / LibriSpeech / recorded) | Entities heard % | processing p50 / p95 ms | RTF |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of batch) {
    const s = r.summary;
    const src = ['synthetic', 'librispeech', 'recorded'].map(k => s.werPctBySource[k] ?? '—').join(' / ');
    console.log(`| ${r.host} | ${r.stt} | ${s.fixtures} | ${s.werPct} (${src}) | ${s.entityAccuracyPct} | ${fmt(s.processingMs)} | ${s.rtf} |`);
  }
}

const tts = files.filter(f => f.startsWith('tts.')).map(f => load<{
  host: string; tts: string; rate: number; summary: { ttfbMs: Stat; rtf: Stat; stallMs: Stat; sentencesWithStall: number; cancelToDoneMs: Stat; framesAfterCancel: number; serviceRssMb: { before: number | null; after: number | null }; concurrentStt: string | null };
}>(f));
tts.sort((a, b) => a.host.localeCompare(b.host) || a.rate - b.rate || a.tts.localeCompare(b.tts));
if (tts.length) {
  console.log('\n### TTS (p50 / p95)\n');
  console.log('| Host | Rate | Engine | STT alongside | first audio ms | RTF | worst stall ms | sentences that stall | cancel → silence ms | service RSS MB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of tts) {
    const s = r.summary;
    console.log(`| ${r.host} | ${r.rate / 1000}k | ${r.tts} | ${s.concurrentStt ?? 'no'} | ${fmt(s.ttfbMs)} | ${fmt(s.rtf)} | ${fmt(s.stallMs)} | ${s.sentencesWithStall} | ${fmt(s.cancelToDoneMs)} | ${s.serviceRssMb.after ?? '—'} |`);
  }
}
