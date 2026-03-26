import { describe, it, expect } from 'vitest';
import {
  NODE_TYPES,
  DECAY_CLASSES,
  createNodeId,
  createEdgeId,
} from '../../../src/memory/types.js';

describe('Knowledge Graph Types', () => {
  it('NODE_TYPES contains all spec-defined types', () => {
    expect(NODE_TYPES).toContain('person');
    expect(NODE_TYPES).toContain('organization');
    expect(NODE_TYPES).toContain('project');
    expect(NODE_TYPES).toContain('decision');
    expect(NODE_TYPES).toContain('event');
    expect(NODE_TYPES).toContain('concept');
    expect(NODE_TYPES).toContain('fact');
  });

  it('DECAY_CLASSES contains all spec-defined classes', () => {
    expect(DECAY_CLASSES).toContain('permanent');
    expect(DECAY_CLASSES).toContain('slow_decay');
    expect(DECAY_CLASSES).toContain('fast_decay');
  });

  it('createNodeId returns a UUID string', () => {
    const id = createNodeId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('createEdgeId returns a UUID string', () => {
    const id = createEdgeId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
