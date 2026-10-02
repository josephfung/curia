import { describe, it, expect } from 'vitest';
import { argsMatch, matchToolStub } from '../../scenarios/stub-matcher.js';
import type { ToolStub } from '../../scenarios/types.js';

describe('argsMatch', () => {
  it('matches when every key in the pattern equals the argument (extra args ignored)', () => {
    expect(argsMatch({ action: 'edit' }, { action: 'edit', job_id: 'j1' })).toBe(true);
    expect(argsMatch({ action: 'edit' }, { action: 'pause' })).toBe(false);
  });

  it('treats {} as a catch-all', () => {
    expect(argsMatch({}, {})).toBe(true);
    expect(argsMatch({}, { anything: 1 })).toBe(true);
  });

  it('treats null as "argument absent"', () => {
    expect(argsMatch({ status: null }, {})).toBe(true);
    expect(argsMatch({ status: null }, { status: null })).toBe(true);
    expect(argsMatch({ status: null }, { status: 'active' })).toBe(false);
    // An empty string is present, not absent.
    expect(argsMatch({ status: null }, { status: '' })).toBe(false);
  });

  it('compares objects and arrays structurally', () => {
    expect(argsMatch({ ids: ['a', 'b'] }, { ids: ['a', 'b'] })).toBe(true);
    expect(argsMatch({ ids: ['a', 'b'] }, { ids: ['b', 'a'] })).toBe(false);
    expect(argsMatch({ meta: { x: 1 } }, { meta: { x: 1 } })).toBe(true);
  });
});

describe('matchToolStub', () => {
  const stubs: Record<string, ToolStub[]> = {
    'scheduler-update': [
      { match: { action: 'edit', job_id: 'job-1' }, return: { updated: true } },
      { match: {}, error: 'job not found' },
    ],
  };

  it('returns the first matching stub', () => {
    expect(matchToolStub('scheduler-update', { action: 'edit', job_id: 'job-1' }, stubs))
      .toEqual({ match: { action: 'edit', job_id: 'job-1' }, return: { updated: true } });
    expect(matchToolStub('scheduler-update', { action: 'edit', job_id: 'other' }, stubs)?.error)
      .toBe('job not found');
  });

  it('returns undefined for an unstubbed tool or no match', () => {
    expect(matchToolStub('email-send', {}, stubs)).toBeUndefined();
    expect(matchToolStub('x', {}, { x: [{ match: { a: 1 }, return: {} }] })).toBeUndefined();
  });
});
