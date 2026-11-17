// Copy run outputs into results/ for committing, without the per-event
// timelines (large, and only needed while debugging a run).
//
//   pnpm exec tsx scripts/spikes/local-speech/collect-results.ts <run-dir> [...]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'results');

/** One record per line: readable, and a rerun diffs per fixture rather than per field. */
function compact(run: Record<string, unknown>): string {
  const keys = Object.keys(run);
  const body = keys.map((k, i) => {
    const v = run[k];
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      return ` ${JSON.stringify(k)}: [\n${v.map(x => `  ${JSON.stringify(x)}`).join(',\n')}\n ]${comma}`;
    }
    return ` ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`;
  });
  return `{\n${body.join('\n')}\n}\n`;
}
mkdirSync(OUT, { recursive: true });
for (const dir of process.argv.slice(2)) {
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { results?: Array<Record<string, unknown>> };
    for (const r of run.results ?? []) delete r['events'];
    writeFileSync(join(OUT, f), compact(run as Record<string, unknown>));
  }
}
process.stdout.write(`${readdirSync(OUT).length} files in ${OUT}\n`);
