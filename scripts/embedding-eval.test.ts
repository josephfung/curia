import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EmbeddingService } from '../src/memory/embedding.js';
import { ALL_MINILM_L6_V2 } from '../src/memory/embedding-profiles.js';
import { extractIdentifierTokens, hasConflictingIdentifiers } from '../src/memory/identifier-guard.js';
import {
  DEFAULT_FIXTURE,
  DEFAULT_FIXTURES,
  STRUCTURED_FIXTURE,
  bestF1,
  chooseThreshold,
  evaluate,
  keepFloor,
  loadFixture,
  noFalseMerge,
  parseArgs,
  rankingMetrics,
  rocAuc,
  scoreAt,
  separationMargin,
  type EvalFixture,
} from './embedding-eval.js';

describe('rocAuc', () => {
  it('is 1 when every true pair outscores every false pair', () => {
    expect(rocAuc([0.9, 0.8], [0.5, 0.4])).toBe(1);
  });

  it('counts ties as half and inversions as zero', () => {
    // pairs: (0.6>0.5)=1, (0.6=0.6)=0.5, (0.4<0.5)=0, (0.4<0.6)=0
    expect(rocAuc([0.6, 0.4], [0.5, 0.6])).toBe(0.375);
  });
});

describe('thresholds', () => {
  const pos = [0.95, 0.9, 0.85, 0.7];
  const neg = [0.8, 0.6, 0.5];

  it('scores a threshold as merging everything at or above it', () => {
    const point = scoreAt(pos, neg, 0.8);
    expect(point.falseMerges).toBe(1);
    expect(point.recall).toBe(0.75);
    expect(point.precision).toBe(0.75);
  });

  it('finds the lowest grid threshold with no false merge', () => {
    const point = noFalseMerge(pos, neg)!;
    expect(point.threshold).toBe(0.81);
    expect(point.falseMerges).toBe(0);
    expect(point.recall).toBe(0.75);
  });

  it('returns undefined when no grid threshold avoids a false merge', () => {
    expect(noFalseMerge([0.9], [1])).toBeUndefined();
  });

  it('breaks a best-F1 tie towards the higher threshold', () => {
    // Every threshold in (0.6, 0.7] gives the same F1; the highest is 0.70.
    expect(bestF1([0.9, 0.7], [0.6]).threshold).toBe(0.7);
  });

  it('prefers no-false-merge when it admits a true pair', () => {
    const chosen = chooseThreshold(pos, neg);
    expect(chosen.rule).toBe('no_false_merge');
    expect(chosen.point.threshold).toBe(0.81);
  });

  it('keeps no-false-merge even when best-F1 is far ahead', () => {
    // One false pair scores above all but one true pair: F1 0.40 against 0.89.
    const chosen = chooseThreshold([0.99, 0.8, 0.8, 0.8], [0.9, 0.1]);
    expect(chosen.rule).toBe('no_false_merge');
    expect(chosen.point.threshold).toBe(0.91);
  });

  it('falls back to best-F1 when no threshold admits a true pair without a false one', () => {
    const chosen = chooseThreshold([0.8, 0.7], [0.9, 0.1]);
    expect(chosen.rule).toBe('best_f1');
    expect(chosen.point.threshold).toBe(0.7);
  });

  it('reports the separation margin, negative when the sets overlap', () => {
    expect(separationMargin(pos, neg)).toBeCloseTo(-0.1);
    expect(separationMargin([0.9], [0.7])).toBeCloseTo(0.2);
  });

  it('sets the floor where the given share of true scores stays above it', () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.02); // 0.50 .. 0.88
    expect(keepFloor(scores, 0.95)).toBe(0.52);
  });
});

describe('rankingMetrics', () => {
  it('averages recall@k and reciprocal rank over queries', () => {
    const metrics = rankingMetrics([
      { ranked: ['a', 'b', 'c'], relevant: ['a'] },        // recall 1, RR 1
      { ranked: ['x', 'y', 'b', 'z'], relevant: ['b', 'q'] }, // recall 0.5, RR 1/3
      { ranked: ['x', 'y', 'z'], relevant: ['w'] },        // recall 0, RR 0
    ], 3);
    expect(metrics.recallAtK).toBeCloseTo(0.5);
    expect(metrics.mrr).toBeCloseTo((1 + 1 / 3) / 3);
  });
});

describe('loadFixture', () => {
  it('loads the shipped fixture', () => {
    const fixture = loadFixture(DEFAULT_FIXTURE);
    expect(fixture.entities.match.length).toBeGreaterThan(20);
    expect(fixture.facts.distinct.length).toBeGreaterThan(20);
    expect(fixture.search.queries.length).toBeGreaterThan(10);
  });

  it('rejects a query whose relevant label is not in the corpus', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'embedding-eval-')), 'bad.json');
    writeFileSync(file, JSON.stringify({
      entities: { match: [], distinct: [] },
      facts: { merge: [], distinct: [] },
      search: { corpus: ['a'], queries: [{ query: 'q', relevant: ['missing'] }] },
    }));
    expect(() => loadFixture(file)).toThrow(/missing from search.corpus/);
  });
});

describe('parseArgs', () => {
  it('requires an endpoint without --bundled', () => {
    expect(() => parseArgs(['--widths', '384'])).toThrow(/--base-url and --model are required/);
  });

  it('parses --bundled with no endpoint, defaulting to the bundled width and model dir', () => {
    const args = parseArgs(['--bundled']);
    expect(args.bundled).toBe(true);
    expect(args.baseUrl).toBeUndefined();
    expect(args.widths).toEqual([ALL_MINILM_L6_V2.dimensions]);
    expect(args.modelDir).toMatch(/models[/\\]embedding[/\\]all-MiniLM-L6-v2$/);
    expect(args.identifierGuard).toBe(false);
  });

  it('takes --model-dir with --bundled', () => {
    expect(parseArgs(['--bundled', '--model-dir', '/opt/weights']).modelDir).toBe('/opt/weights');
  });

  it('rejects an endpoint flag with --bundled', () => {
    expect(() => parseArgs(['--bundled', '--base-url', 'x'])).toThrow(/--bundled/);
    expect(() => parseArgs(['--bundled', '--model', 'x'])).toThrow(/--bundled/);
  });

  it('rejects --model-dir without --bundled', () => {
    expect(() => parseArgs(['--base-url', 'x', '--model', 'm', '--widths', '8', '--model-dir', '/w'])).toThrow(/--model-dir/);
  });

  it('rejects a width wider than the bundled model', () => {
    expect(() => parseArgs(['--bundled', '--widths', '512'])).toThrow(/384/);
  });

  it('sets the identifier guard flag', () => {
    expect(parseArgs(['--bundled', '--identifier-guard']).identifierGuard).toBe(true);
  });

  it('runs both committed fixtures by default and any number of --fixture files when given', () => {
    expect(parseArgs(['--bundled']).fixtures).toEqual(DEFAULT_FIXTURES);
    expect(parseArgs(['--bundled', '--fixture', 'a.json', '--fixture', 'b.json']).fixtures).toEqual(['a.json', 'b.json']);
  });
});

describe('evaluate with the identifier guard', () => {
  const fixture: EvalFixture = {
    entities: {
      match: [['Testperson Alpha', 'T. Alpha'], ['Order 4471-2290', 'order #4471-2290']],
      // The second pair differs by one digit: the guard must keep it out of the thresholds.
      distinct: [['Testperson Alpha', 'Zorvath Quill'], ['Order 4471-2290', 'Order 4471-2291']],
    },
    facts: {
      merge: [['tax: $1,204.50', 'tax: $1,204.50 (unchanged)']],
      // Same identifiers, different attribute: the guard lets it through to the score.
      distinct: [
        ['start_time: 2031-03-04 09:00', 'end_time: 2031-03-04 09:00'],
        ['invoice_total: $3,410.00', 'invoice_tax: $410.00'],
        ['likes tea', 'likes coffee'],
      ],
    },
    search: { corpus: ['Testperson Alpha'], queries: [{ query: 'testperson', relevant: ['Testperson Alpha'] }] },
  };
  const service = EmbeddingService.createForTesting(ALL_MINILM_L6_V2);

  it('drops the pairs the guard blocks and counts them per class', async () => {
    const [report] = await evaluate(fixture, service, [ALL_MINILM_L6_V2.dimensions], { identifierGuard: true });
    expect(report!.entities.pairs).toEqual({ pos: 2, neg: 1 });
    expect(report!.entities.guardDropped).toEqual({ pos: 0, neg: 1 });
    expect(report!.facts.pairs).toEqual({ pos: 1, neg: 2 });
    expect(report!.facts.guardDropped).toEqual({ pos: 0, neg: 1 });
  });

  it('refuses a fixture the guard leaves without false pairs', async () => {
    const onlyIds: EvalFixture = { ...fixture, entities: { match: fixture.entities.match, distinct: [['Order 4471-2290', 'Order 4471-2291']] } };
    await expect(evaluate(onlyIds, service, [ALL_MINILM_L6_V2.dimensions], { identifierGuard: true }))
      .rejects.toThrow(/entities: needs at least one true and one false pair/);
  });

  it('keeps every pair when the guard is off', async () => {
    const [report] = await evaluate(fixture, service, [ALL_MINILM_L6_V2.dimensions]);
    expect(report!.entities.pairs).toEqual({ pos: 2, neg: 2 });
    expect(report!.entities.guardDropped).toEqual({ pos: 0, neg: 0 });
  });
});

describe('structured fixture', () => {
  it('loads and holds the cases the design calls for', () => {
    const fixture = loadFixture(STRUCTURED_FIXTURE);
    expect(fixture.facts.merge.length).toBeGreaterThanOrEqual(20);
    expect(fixture.facts.distinct.length).toBeGreaterThanOrEqual(20);
    expect(fixture.entities.match.length).toBeGreaterThanOrEqual(15);
    expect(fixture.search.queries.length).toBeGreaterThanOrEqual(10);
    expect(fixture.search.corpus.length).toBeGreaterThanOrEqual(60);
  });

  it('has at least ten ID-like distinct entity pairs, every one blocked by the guard', () => {
    const fixture = loadFixture(STRUCTURED_FIXTURE);
    const idLike = fixture.entities.distinct.filter(([a, b]) => extractIdentifierTokens(a).size > 0 || extractIdentifierTokens(b).size > 0);
    expect(idLike.length).toBeGreaterThanOrEqual(10);
    expect(idLike.filter(([a, b]) => !hasConflictingIdentifiers(a, b))).toEqual([]);
  });

  it('has no same pair the guard would block', () => {
    const fixture = loadFixture(STRUCTURED_FIXTURE);
    const same = [...fixture.entities.match, ...fixture.facts.merge];
    expect(same.filter(([a, b]) => hasConflictingIdentifiers(a, b))).toEqual([]);
  });
});
