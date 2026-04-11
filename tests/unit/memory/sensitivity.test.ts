// sensitivity.test.ts — unit tests for SensitivityClassifier and auto-classification
// in EntityMemory.
//
// Covers:
//  1. SensitivityClassifier.fromRules() — direct rule construction and classification
//  2. Content-based keyword matching (various categories)
//  3. Most-restrictive-wins when multiple rules match
//  4. Default 'internal' when no rule matches
//  5. Category hint bypass (skip keyword scan)
//  6. EntityMemory integration — sensitivity threaded through createEntity/storeFact
//  7. AC: new node without explicit sensitivity → defaults to 'internal'
//  8. AC: financial node → 'confidential'
//  9. Explicit override wins over classifier

import { describe, it, expect, beforeEach } from 'vitest';
import { SensitivityClassifier } from '../../../src/memory/sensitivity.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import type { SensitivityRule } from '../../../src/memory/sensitivity.js';

// -- Fixture rules (mirrors a subset of config/default.yaml) --

const TEST_RULES: SensitivityRule[] = [
  {
    category: 'credentials',
    sensitivity: 'restricted',
    patterns: ['password', 'api key', 'secret key'],
  },
  {
    category: 'board',
    sensitivity: 'restricted',
    patterns: ['board meeting', 'shareholder'],
  },
  {
    category: 'litigation',
    sensitivity: 'restricted',
    patterns: ['lawsuit', 'litigation'],
  },
  {
    category: 'strategy',
    sensitivity: 'restricted',
    patterns: ['acquisition', 'ipo', 'investment banker'],
  },
  {
    category: 'financial',
    sensitivity: 'confidential',
    patterns: ['salary', 'budget', 'revenue', 'invoice'],
  },
  {
    category: 'hr',
    sensitivity: 'confidential',
    patterns: ['performance review', 'termination', 'layoff'],
  },
  {
    category: 'personal',
    sensitivity: 'confidential',
    patterns: ['sin number', 'passport number', 'date of birth'],
  },
  {
    category: 'contract',
    sensitivity: 'confidential',
    patterns: ['nda', 'non-disclosure'],
  },
];

function makeClassifier(): SensitivityClassifier {
  return SensitivityClassifier.fromRules(TEST_RULES);
}

// Minimal no-op logger — EntityMemory now requires a Logger as the 4th arg.
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeEntityMemory(classifier?: SensitivityClassifier): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, noopLogger, classifier);
}

// -- SensitivityClassifier unit tests --

describe('SensitivityClassifier', () => {
  let classifier: SensitivityClassifier;

  beforeEach(() => {
    classifier = makeClassifier();
  });

  describe('default when no rule matches', () => {
    it('returns internal for ordinary text with no sensitive keywords', () => {
      expect(classifier.classify('Meeting notes from Q3 planning', {})).toBe('internal');
    });

    it('returns internal for an empty label with empty properties', () => {
      expect(classifier.classify('', {})).toBe('internal');
    });
  });

  describe('confidential rules', () => {
    it('matches salary in label → confidential', () => {
      expect(classifier.classify('salary for Q4', {})).toBe('confidential');
    });

    it('matches salary in property value → confidential', () => {
      expect(classifier.classify('Q4 compensation note', { detail: 'revised salary budget' })).toBe('confidential');
    });

    it('matches budget keyword → confidential', () => {
      expect(classifier.classify('Annual budget review notes', {})).toBe('confidential');
    });

    it('matches invoice in label → confidential', () => {
      expect(classifier.classify('Invoice #1042 for services', {})).toBe('confidential');
    });

    it('matches performance review in label → confidential (hr)', () => {
      expect(classifier.classify('performance review for Alice', {})).toBe('confidential');
    });

    it('matches termination keyword → confidential (hr)', () => {
      expect(classifier.classify('Termination letter sent', {})).toBe('confidential');
    });

    it('matches sin number in value → confidential (personal)', () => {
      expect(classifier.classify('Employee record', { id_info: 'SIN number 123456789' })).toBe('confidential');
    });

    it('matches NDA keyword → confidential (contract)', () => {
      expect(classifier.classify('NDA signed with Vendor X', {})).toBe('confidential');
    });
  });

  describe('restricted rules', () => {
    it('matches password in label → restricted', () => {
      expect(classifier.classify('Admin password reset', {})).toBe('restricted');
    });

    it('matches api key in property value → restricted', () => {
      expect(classifier.classify('Integration config', { notes: 'store the api key here' })).toBe('restricted');
    });

    it('matches board meeting → restricted', () => {
      expect(classifier.classify('Board meeting agenda', {})).toBe('restricted');
    });

    it('matches lawsuit → restricted', () => {
      expect(classifier.classify('Ongoing lawsuit with supplier', {})).toBe('restricted');
    });

    it('matches litigation → restricted', () => {
      expect(classifier.classify('Litigation status update', {})).toBe('restricted');
    });

    it('matches acquisition → restricted (strategy)', () => {
      expect(classifier.classify('Acquisition target analysis', {})).toBe('restricted');
    });

    it('matches ipo → restricted (strategy)', () => {
      expect(classifier.classify('IPO roadshow planning', {})).toBe('restricted');
    });

    it('matches investment banker → restricted (strategy)', () => {
      expect(classifier.classify('Meeting with investment banker', {})).toBe('restricted');
    });
  });

  describe('most-restrictive wins when multiple rules match', () => {
    it('restricted beats confidential when both match', () => {
      // "salary" (confidential/financial) + "board meeting" (restricted/board) in same text
      const result = classifier.classify('Board meeting: salary discussion', {});
      expect(result).toBe('restricted');
    });

    it('restricted beats confidential when match is in property', () => {
      const result = classifier.classify('Q4 revenue report', { context: 'board meeting materials' });
      expect(result).toBe('restricted');
    });
  });

  describe('category hint bypass', () => {
    it('returns the category sensitivity without scanning keywords when category matches', () => {
      // Label has no financial keywords, but category hint forces 'confidential'
      const result = classifier.classify('Q4 planning notes', {}, 'financial');
      expect(result).toBe('confidential');
    });

    it('category hint for restricted category returns restricted regardless of content', () => {
      const result = classifier.classify('generic label', {}, 'board');
      expect(result).toBe('restricted');
    });

    it('unknown category hint falls through to keyword scan', () => {
      // 'unknown-category' doesn't match any rule.category, so falls through to keywords
      const result = classifier.classify('salary update', {}, 'unknown-category');
      expect(result).toBe('confidential'); // matched by financial keyword
    });
  });

  describe('fromRules validation', () => {
    it('sorts rules so restricted is checked before confidential', () => {
      // Both salary (confidential) and password (restricted) match — restricted must win
      const c = SensitivityClassifier.fromRules(TEST_RULES);
      expect(c.classify('salary password', {})).toBe('restricted');
    });
  });
});

// -- EntityMemory integration tests --

describe('EntityMemory sensitivity integration', () => {
  describe('without a classifier', () => {
    let em: EntityMemory;

    beforeEach(() => {
      em = makeEntityMemory(); // no classifier
    });

    it('AC: new entity without explicit sensitivity defaults to internal', async () => {
      const { entity: node } = await em.createEntity({
        type: 'concept',
        label: 'Q3 planning notes',
        properties: {},
        source: 'test',
      });
      expect(node.sensitivity).toBe('internal');
    });

    it('AC: new fact without explicit sensitivity defaults to internal', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'some meeting note',
        source: 'test',
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('internal');
    });
  });

  describe('with a classifier', () => {
    let em: EntityMemory;

    beforeEach(() => {
      em = makeEntityMemory(makeClassifier());
    });

    it('AC: new node without explicit sensitivity → defaults to internal (non-sensitive content)', async () => {
      const { entity: node } = await em.createEntity({
        type: 'concept',
        label: 'Q3 planning notes',
        properties: {},
        source: 'test',
      });
      expect(node.sensitivity).toBe('internal');
    });

    it('AC: financial fact auto-tagged as confidential', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Q4 salary budget approved',
        source: 'test',
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('confidential');
    });

    it('restricted content auto-tagged as restricted', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Board meeting agenda for November',
        source: 'test',
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('restricted');
    });

    it('property values trigger classification', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Employee record',
        properties: { detail: 'sin number on file' },
        source: 'test',
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('confidential');
    });

    it('explicit override wins over classifier (public beats confidential content)', async () => {
      const { entity: node } = await em.createEntity({
        type: 'concept',
        label: 'Annual budget summary',   // would normally be confidential
        properties: {},
        source: 'test',
        sensitivity: 'public',            // explicit override
      });
      expect(node.sensitivity).toBe('public');
    });

    it('explicit override wins over classifier on storeFact', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Password reset policy',   // would be restricted
        source: 'test',
        sensitivity: 'internal',          // explicit override
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('internal');
    });

    it('category hint forces classification without keyword match', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'Q4 planning session',     // no financial keywords
        source: 'test',
        sensitivityCategory: 'financial', // hint forces confidential
      });
      expect(result.stored).toBe(true);
      expect(result.sensitivity).toBe('confidential');
    });

    it('sensitivity is preserved on the node returned by createEntity', async () => {
      const { entity: node } = await em.createEntity({
        type: 'decision',
        label: 'litigation hold initiated',
        properties: {},
        source: 'test',
      });
      expect(node.sensitivity).toBe('restricted');
    });

    it('storeFact result includes sensitivity for audit event emission', async () => {
      const { entity } = await em.createEntity({ type: 'concept', label: 'anchor', properties: {}, source: 'test' });
      const result = await em.storeFact({
        entityNodeId: entity.id,
        label: 'NDA signed with partner',
        source: 'test',
      });
      // result.sensitivity is used by the ExecutionLayer to populate the memory.store event
      expect(result.sensitivity).toBe('confidential');
    });
  });
});
