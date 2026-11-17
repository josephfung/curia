// embedding-eval.ts — calibrates an embedding profile against a labelled fixture
// (ADR-051). It embeds the fixture through any OpenAI-compatible /embeddings
// endpoint, scores each requested width app-side, and prints the metrics and a suggested
// profile for `embedding.profiles`.
//
//   pnpm embedding-eval --base-url http://localhost:8080/v1 --model Qwen3-Embedding-4B \
//     --widths 1536,2000,2560 --key-env EMBED_KEY \
//     --query-prefix $'Instruct: <task>\nQuery:'
//
// --key-env names the environment variable that holds the endpoint's key, so the key is
// never on the command line. Omit it for a server that takes no key.
//
// --bundled scores the model Curia runs in-process (all-MiniLM-L6-v2) through the same
// backend production uses, from models/embedding/all-MiniLM-L6-v2 or --model-dir:
//
//   pnpm embedding-eval --bundled --identifier-guard [--fixture private.json]
//
// --identifier-guard drops every pair the identifier guard blocks before thresholds are
// chosen. Production never merges a blocked pair whatever its score, so a threshold chosen
// with the guard on matches what runs. The report says how many pairs it dropped per class.
//
// Without --fixture, both committed fixtures run, each reported on its own. --fixture may
// be repeated.
//
// The vectors are fetched once at the widest requested width, then truncated and
// renormalised per width exactly as the service does, so a width above the 2,000 the
// index allows can be measured without a schema change.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import pino from 'pino';
import { DEFAULT_EMBEDDING_MODEL_DIR } from '../src/config.js';
import { EmbeddingService, truncateAndNormalize } from '../src/memory/embedding.js';
import { hashBundledWeights } from '../src/memory/embedding-onnx.js';
import {
  ALL_MINILM_L6_V2,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  embeddingStamp,
  type EmbeddingProfile,
  type EmbeddingPurpose,
} from '../src/memory/embedding-profiles.js';
import { hasConflictingIdentifiers } from '../src/memory/identifier-guard.js';

export const DEFAULT_FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/embedding-eval/fixture.json');
/** Structured `attribute: value` facts, ID-like labels and name variants (design §6). */
export const STRUCTURED_FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/embedding-eval/fixture-structured.json');
export const DEFAULT_FIXTURES: readonly string[] = [DEFAULT_FIXTURE, STRUCTURED_FIXTURE];

/** Thresholds are picked on this grid, so a suggested value has two decimals like the shipped ones. */
const GRID_STEPS = 100;
/** The ambiguity floor keeps this share of true entity pairs above it. */
export const FLOOR_KEEP = 0.95;
const RECALL_AT = 5;
const CONCURRENCY = 4;

type Pair = [string, string];

export interface EvalFixture {
  entities: { match: Pair[]; distinct: Pair[] };
  facts: { merge: Pair[]; distinct: Pair[] };
  search: { corpus: string[]; queries: Array<{ query: string; relevant: string[] }> };
}

export function loadFixture(file: string): EvalFixture {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<EvalFixture>;
  const pairs = (v: unknown, at: string): Pair[] => {
    if (!Array.isArray(v) || v.some(p => !Array.isArray(p) || p.length !== 2 || p.some(s => typeof s !== 'string'))) {
      throw new Error(`${file}: ${at} must be a list of [string, string] pairs`);
    }
    return v as Pair[];
  };
  const corpus = raw.search?.corpus;
  const queries = raw.search?.queries;
  if (!Array.isArray(corpus) || !Array.isArray(queries)) {
    throw new Error(`${file}: search.corpus and search.queries must be lists`);
  }
  for (const q of queries) {
    const missing = q.relevant.filter(label => !corpus.includes(label));
    if (missing.length > 0) {
      throw new Error(`${file}: query "${q.query}" names labels missing from search.corpus: ${missing.join('; ')}`);
    }
  }
  return {
    entities: { match: pairs(raw.entities?.match, 'entities.match'), distinct: pairs(raw.entities?.distinct, 'entities.distinct') },
    facts: { merge: pairs(raw.facts?.merge, 'facts.merge'), distinct: pairs(raw.facts?.distinct, 'facts.distinct') },
    search: { corpus, queries },
  };
}

// -- Metrics over cosine scores. pos = pairs that should merge, neg = pairs that must not. --

/** Probability that a random true pair outscores a random false pair (ties count half). */
export function rocAuc(pos: readonly number[], neg: readonly number[]): number {
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

export interface ThresholdPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
}

/** Outcome of merging every pair whose score is at or above `threshold`, as the service does. */
export function scoreAt(pos: readonly number[], neg: readonly number[], threshold: number): ThresholdPoint {
  const tp = pos.filter(s => s >= threshold).length;
  const fp = neg.filter(s => s >= threshold).length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp / pos.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { threshold, precision, recall, f1, falseMerges: fp };
}

function grid(): number[] {
  return Array.from({ length: GRID_STEPS + 1 }, (_, i) => i / GRID_STEPS);
}

/** The grid threshold with the best F1; the highest one on a tie, since a false merge costs more. */
export function bestF1(pos: readonly number[], neg: readonly number[]): ThresholdPoint {
  let best = scoreAt(pos, neg, 0);
  for (const t of grid()) {
    const point = scoreAt(pos, neg, t);
    if (point.f1 >= best.f1) best = point;
  }
  return best;
}

/** The lowest grid threshold at which no false pair merges, or undefined if none on the grid does. */
export function noFalseMerge(pos: readonly number[], neg: readonly number[]): ThresholdPoint | undefined {
  for (const t of grid()) {
    const point = scoreAt(pos, neg, t);
    if (point.falseMerges === 0) return point;
  }
  return undefined;
}

/**
 * Picks the threshold for a merge decision. A false merge destroys stored data and a missed
 * merge costs a duplicate, so the no-false-merge threshold wins whenever one admits any true
 * pair, however much F1 it gives up. Best-F1 is the fallback only when none does.
 */
export function chooseThreshold(
  pos: readonly number[],
  neg: readonly number[],
): { point: ThresholdPoint; rule: 'no_false_merge' | 'best_f1' } {
  const best = bestF1(pos, neg);
  const safe = noFalseMerge(pos, neg);
  if (safe && safe.recall > 0) return { point: safe, rule: 'no_false_merge' };
  return { point: best, rule: 'best_f1' };
}

/** Lowest true score minus highest false score. Positive means one threshold separates them all. */
export function separationMargin(pos: readonly number[], neg: readonly number[]): number {
  return Math.min(...pos) - Math.max(...neg);
}

/** The grid value at or below which at most (1 - keep) of the true scores fall. */
export function keepFloor(pos: readonly number[], keep: number): number {
  const sorted = [...pos].sort((a, b) => a - b);
  const index = Math.floor((1 - keep) * sorted.length);
  const score = sorted[Math.min(index, sorted.length - 1)]!;
  // The epsilon keeps a score such as 0.57 from flooring to 0.56 through float error.
  return Math.floor(score * GRID_STEPS + 1e-9) / GRID_STEPS;
}

/** Mean recall@k and mean reciprocal rank, given each query's labels ranked best first. */
export function rankingMetrics(
  results: ReadonlyArray<{ ranked: readonly string[]; relevant: readonly string[] }>,
  k: number,
): { recallAtK: number; mrr: number } {
  let recall = 0;
  let reciprocal = 0;
  for (const { ranked, relevant } of results) {
    const top = ranked.slice(0, k);
    recall += relevant.filter(label => top.includes(label)).length / relevant.length;
    const firstHit = ranked.findIndex(label => relevant.includes(label));
    reciprocal += firstHit === -1 ? 0 : 1 / (firstHit + 1);
  }
  return { recallAtK: recall / results.length, mrr: reciprocal / results.length };
}

// -- Evaluation --

export interface PairTaskReport {
  /** Pairs scored per class, after any the identifier guard dropped. */
  pairs: { pos: number; neg: number };
  /** Pairs the identifier guard dropped per class (zero with the guard off). */
  guardDropped: { pos: number; neg: number };
  auc: number;
  bestF1: ThresholdPoint;
  noFalseMerge: ThresholdPoint | undefined;
  chosen: { point: ThresholdPoint; rule: 'no_false_merge' | 'best_f1' };
  margin: number;
}

export interface WidthReport {
  width: number;
  entities: PairTaskReport & { ambiguityFloor: number };
  facts: PairTaskReport;
  search: { recallAtK: number; mrr: number };
  suggested: EmbeddingProfile['thresholds'];
}

function pairTask(pos: number[], neg: number[], guardDropped: PairTaskReport['guardDropped']): PairTaskReport {
  return {
    pairs: { pos: pos.length, neg: neg.length },
    guardDropped,
    auc: rocAuc(pos, neg),
    bestF1: bestF1(pos, neg),
    noFalseMerge: noFalseMerge(pos, neg),
    chosen: chooseThreshold(pos, neg),
    margin: separationMargin(pos, neg),
  };
}

/**
 * Scores the fixture at each width. Each pair is embedded the way the service compares it:
 * the incoming label as `similarity` against the stored label as `document`, and a search
 * query as `query` against stored labels as `document`.
 */
export async function evaluate(
  fixture: EvalFixture,
  service: EmbeddingService,
  widths: readonly number[],
  options: { identifierGuard?: boolean } = {},
): Promise<WidthReport[]> {
  const wanted = new Map<string, { text: string; purpose: EmbeddingPurpose }>();
  const key = (text: string, purpose: EmbeddingPurpose) => `${purpose}\u0000${text}`;
  const want = (text: string, purpose: EmbeddingPurpose) => wanted.set(key(text, purpose), { text, purpose });
  for (const [a, b] of [...fixture.entities.match, ...fixture.entities.distinct, ...fixture.facts.merge, ...fixture.facts.distinct]) {
    want(a, 'similarity');
    want(b, 'document');
  }
  for (const label of fixture.search.corpus) want(label, 'document');
  for (const q of fixture.search.queries) want(q.query, 'query');

  const full = new Map<string, number[]>();
  const items = [...wanted.entries()];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(async ([k, { text, purpose }]) => {
      full.set(k, await service.embed(text, purpose));
    }));
  }

  return widths.map(width => {
    const vec = (text: string, purpose: EmbeddingPurpose) => truncateAndNormalize(full.get(key(text, purpose))!, width);
    const scores = (pairs: Pair[]) => pairs.map(([a, b]) => EmbeddingService.cosineSimilarity(vec(a, 'similarity'), vec(b, 'document')));

    // With the guard on, a blocked pair never merges in production whatever it scores, so
    // it says nothing about where the threshold belongs: drop it from both classes.
    const task = (name: string, posPairs: Pair[], negPairs: Pair[]) => {
      const keep = (pairs: Pair[]) => options.identifierGuard ? pairs.filter(([a, b]) => !hasConflictingIdentifiers(a, b)) : pairs;
      const pos = keep(posPairs);
      const neg = keep(negPairs);
      // Every metric divides by the class sizes; an empty class would print NaN thresholds.
      if (pos.length === 0 || neg.length === 0) {
        throw new Error(`${name}: needs at least one true and one false pair to score, has ${pos.length} and ${neg.length}` +
          (options.identifierGuard ? ' after the identifier guard' : ''));
      }
      const posScores = scores(pos);
      const report = pairTask(posScores, scores(neg), { pos: posPairs.length - pos.length, neg: negPairs.length - neg.length });
      return { report, posScores };
    };

    const entityTask = task('entities', fixture.entities.match, fixture.entities.distinct);
    const entities = { ...entityTask.report, ambiguityFloor: keepFloor(entityTask.posScores, FLOOR_KEEP) };
    const facts = task('facts', fixture.facts.merge, fixture.facts.distinct).report;

    const corpus = fixture.search.corpus.map(label => ({ label, v: vec(label, 'document') }));
    const search = rankingMetrics(fixture.search.queries.map(q => {
      const qv = vec(q.query, 'query');
      const ranked = corpus
        .map(c => ({ label: c.label, score: EmbeddingService.cosineSimilarity(qv, c.v) }))
        .sort((a, b) => b.score - a.score)
        .map(c => c.label);
      return { ranked, relevant: q.relevant };
    }), RECALL_AT);

    const fuzzyResolve = entities.chosen.point.threshold;
    return {
      width,
      entities,
      facts,
      search,
      suggested: {
        factDedup: facts.chosen.point.threshold,
        fuzzyResolve,
        // The floor must sit below the auto-resolve threshold, or nothing is ever ambiguous.
        fuzzyAmbiguityFloor: Math.min(entities.ambiguityFloor, Math.round((fuzzyResolve - 1 / GRID_STEPS) * GRID_STEPS) / GRID_STEPS),
      },
    };
  });
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function describePairTask(name: string, t: PairTaskReport, identifierGuard: boolean): string[] {
  const safe = t.noFalseMerge
    ? `${t.noFalseMerge.threshold.toFixed(2)} (F1 ${fmt(t.noFalseMerge.f1)}, recall ${fmt(t.noFalseMerge.recall)})`
    : 'none on the grid';
  return [
    `  ${name}: ${t.pairs.pos} true / ${t.pairs.neg} false pairs` +
      (identifierGuard ? `, identifier guard dropped ${t.guardDropped.pos} true / ${t.guardDropped.neg} false` : ''),
    `    ROC-AUC ${fmt(t.auc)}, separation margin ${fmt(t.margin)}`,
    `    best-F1 threshold ${t.bestF1.threshold.toFixed(2)} (F1 ${fmt(t.bestF1.f1)}, ${t.bestF1.falseMerges} false merge(s))`,
    `    no-false-merge threshold ${safe}`,
    `    chosen ${t.chosen.point.threshold.toFixed(2)} by ${t.chosen.rule === 'no_false_merge' ? 'no-false-merge' : 'best-F1'}` +
      ` (merges ${fmt(t.chosen.point.recall)} of true pairs, ${t.chosen.point.falseMerges} false merge(s))`,
  ];
}

export function formatReport(
  model: string,
  prefixes: EmbeddingProfile['prefixes'],
  reports: readonly WidthReport[],
  context: { fixture?: string; identifierGuard?: boolean } = {},
): string {
  const lines = [`Model ${model}`, `Prefixes ${JSON.stringify(prefixes)}`];
  if (context.fixture) lines.push(`Fixture ${context.fixture}`);
  lines.push(`Identifier guard ${context.identifierGuard ? 'on' : 'off'}`, '');
  for (const r of reports) {
    lines.push(`Width ${r.width}`);
    lines.push(...describePairTask('Entity resolution', r.entities, context.identifierGuard ?? false));
    lines.push(`    ambiguity floor (keeps ${FLOOR_KEEP * 100}% of true pairs) ${r.entities.ambiguityFloor.toFixed(2)}`);
    lines.push(...describePairTask('Fact dedup', r.facts, context.identifierGuard ?? false));
    lines.push(`  Search: recall@${RECALL_AT} ${fmt(r.search.recallAtK)}, MRR ${fmt(r.search.mrr)}`);
    lines.push(
      `  Suggested thresholds: fact_dedup ${r.suggested.factDedup.toFixed(2)}, ` +
      `fuzzy_resolve ${r.suggested.fuzzyResolve.toFixed(2)}, fuzzy_ambiguity_floor ${r.suggested.fuzzyAmbiguityFloor.toFixed(2)}`,
    );
    lines.push('');
  }
  return lines.join('\n');
}

// -- CLI --

export interface EvalArgs {
  /** Score the in-process bundled model instead of an endpoint. */
  bundled: boolean;
  /** The bundled model's files; set only with `bundled`. */
  modelDir: string | undefined;
  /** The endpoint; set only without `bundled`. */
  baseUrl: string | undefined;
  model: string | undefined;
  keyEnv: string | undefined;
  widths: number[];
  prefixes: EmbeddingProfile['prefixes'];
  /** Drop pairs the identifier guard blocks before choosing thresholds. */
  identifierGuard: boolean;
  /** Each fixture is scored and reported on its own. */
  fixtures: string[];
}

// Flags that describe an endpoint. The bundled model has a fixed profile (no task prompts)
// and no transport, so with --bundled each of these is a mistake worth saying so.
const ENDPOINT_FLAGS = ['base-url', 'model', 'key-env', 'query-prefix', 'document-prefix', 'similarity-prefix'] as const;

export function parseArgs(argv: string[]): EvalArgs {
  const { values } = parseNodeArgs({
    args: argv.filter(a => a !== '--'),
    options: {
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'key-env': { type: 'string' },
      widths: { type: 'string' },
      'query-prefix': { type: 'string' },
      'document-prefix': { type: 'string' },
      'similarity-prefix': { type: 'string' },
      fixture: { type: 'string', multiple: true },
      bundled: { type: 'boolean' },
      'model-dir': { type: 'string' },
      'identifier-guard': { type: 'boolean' },
    },
    strict: true,
  });
  const bundled = values.bundled ?? false;
  const baseUrl = values['base-url'];
  const model = values.model;
  if (bundled) {
    const given = ENDPOINT_FLAGS.filter(flag => values[flag] !== undefined);
    if (given.length > 0) {
      throw new Error(`--bundled scores the in-process model, so it takes no endpoint flags; remove ${given.map(f => `--${f}`).join(', ')}`);
    }
  } else {
    if (!baseUrl || !model) throw new Error('--base-url and --model are required (or pass --bundled)');
    if (values['model-dir'] !== undefined) throw new Error('--model-dir applies only with --bundled');
  }
  // The bundled model has one width; it is the default, and nothing wider exists to truncate.
  const widths = (values.widths ?? (bundled ? String(ALL_MINILM_L6_V2.dimensions) : ''))
    .split(',').filter(Boolean).map(w => Number.parseInt(w, 10));
  if (widths.length === 0 || widths.some(w => !Number.isInteger(w) || w < 1)) {
    throw new Error(`--widths must be a comma-separated list of positive integers, got: ${values.widths ?? ''}`);
  }
  if (bundled && widths.some(w => w > ALL_MINILM_L6_V2.dimensions)) {
    throw new Error(`--widths: the bundled model's vectors are ${ALL_MINILM_L6_V2.dimensions} wide, got: ${values.widths ?? ''}`);
  }
  return {
    bundled,
    modelDir: bundled ? path.resolve(process.cwd(), values['model-dir'] ?? DEFAULT_EMBEDDING_MODEL_DIR) : undefined,
    baseUrl: baseUrl?.replace(/\/+$/, ''),
    model,
    keyEnv: values['key-env'],
    widths,
    prefixes: {
      query: values['query-prefix'] ?? '',
      document: values['document-prefix'] ?? '',
      similarity: values['similarity-prefix'] ?? '',
    },
    identifierGuard: values['identifier-guard'] ?? false,
    fixtures: values.fixture ?? [...DEFAULT_FIXTURES],
  };
}

const logger = pino({ name: 'embedding-eval', level: process.env.LOG_LEVEL ?? 'info' });

/** The service under test and the name the report gives it. */
async function buildService(args: EvalArgs): Promise<{ service: EmbeddingService; name: string; prefixes: EmbeddingProfile['prefixes'] } | undefined> {
  if (args.bundled) {
    const modelDir = args.modelDir!;
    // The same factory and profile production boots with, so the vectors are the ones
    // the thresholds will be applied to. The profile's thresholds are not read here.
    const profile: EmbeddingProfile = { ...ALL_MINILM_L6_V2, weightsSha256: await hashBundledWeights(modelDir, logger) };
    const service = await EmbeddingService.createBundled(modelDir, profile, logger);
    return { service, name: `${embeddingStamp(profile)} (bundled, ${modelDir})`, prefixes: profile.prefixes };
  }

  const model = args.model!;
  let apiKey: string | undefined;
  if (args.keyEnv) {
    apiKey = process.env[args.keyEnv];
    if (!apiKey) {
      logger.error(`embedding-eval: --key-env names ${args.keyEnv}, which is not set`);
      return undefined;
    }
  }
  // Only the transport and the prefixes are used; the thresholds are what this run measures.
  const probe: EmbeddingProfile = {
    model,
    dimensions: Math.max(...args.widths),
    prefixes: args.prefixes,
    thresholds: OPENAI_TEXT_EMBEDDING_3_SMALL.thresholds,
  };
  const service = EmbeddingService.createWithEndpoint({ baseUrl: args.baseUrl!, model, apiKey }, probe, logger);
  return { service, name: model, prefixes: args.prefixes };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // Load every fixture first, so a malformed one fails before any embedding work.
  const fixtures = args.fixtures.map(file => ({ file, fixture: loadFixture(file) }));
  const built = await buildService(args);
  if (!built) return 1;
  try {
    for (const { file, fixture } of fixtures) {
      const reports = await evaluate(fixture, built.service, args.widths, { identifierGuard: args.identifierGuard });
      process.stdout.write(
        formatReport(built.name, built.prefixes, reports, { fixture: file, identifierGuard: args.identifierGuard }) + '\n',
      );
    }
    return 0;
  } finally {
    // Release a --bundled run's ONNX session on every path (close() never throws).
    await built.service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not process.exit(): exiting while onnxruntime-node's session is still alive
  // intermittently aborts in its native teardown (libc++abi "recursive_mutex lock failed",
  // exit 134), which turns a finished --bundled run into a failure. Letting the event loop
  // drain shuts it down cleanly.
  main()
    .then(code => { process.exitCode = code; })
    .catch((err: unknown) => {
      logger.error({ err }, 'embedding-eval: failed');
      process.exitCode = 1;
    });
}
