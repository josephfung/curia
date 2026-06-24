// effective-standing.test.ts — the score-keyed bypass ladder (#1125).
//
// Truth table for computeEffectiveTaskMetadata across the design note's postures:
//   < 70  (A) : woken & derived → agent
//   70–89 (B) : same-task wake keeps lineage; derived child → agent
//   >= 90 (D) : same-task wake AND derived child keep lineage

import { describe, it, expect } from 'vitest';
import {
  computeEffectiveTaskMetadata,
  makeWakeContext,
  resolveBypassLadder,
  DEFAULT_BYPASS_LADDER,
} from './effective-standing.js';
import type { TaskOriginator } from '../contacts/types.js';

function principalOriginator(): TaskOriginator {
  return {
    contactId: 'ceo-id',
    systemRole: 'principal',
    channel: 'email',
    initiatedAt: '2026-06-23T00:00:00.000Z',
    tier: 'principal',
  };
}

function systemOriginator(): TaskOriginator {
  return {
    contactId: 'system',
    systemRole: 'system',
    channel: 'declarative',
    initiatedAt: '2026-06-23T00:00:00.000Z',
    tier: null,
  };
}

function role(meta: Record<string, unknown> | undefined): string | null | undefined {
  return (meta?.originator as TaskOriginator | undefined)?.systemRole;
}

describe('computeEffectiveTaskMetadata', () => {
  const ladder = DEFAULT_BYPASS_LADDER;

  it('returns undefined metadata unchanged', () => {
    expect(computeEffectiveTaskMetadata(undefined, 100, ladder)).toBeUndefined();
  });

  it('passes a live turn (no wakeContext) through unchanged at any score', () => {
    const meta = { originator: principalOriginator() };
    expect(computeEffectiveTaskMetadata(meta, 0, ladder)).toBe(meta);
    expect(computeEffectiveTaskMetadata(meta, 100, ladder)).toBe(meta);
  });

  describe('same-task heartbeat wake (derived: false)', () => {
    const wakeContext = makeWakeContext(false);

    it('keeps principal standing at score >= 70 (posture B)', () => {
      const meta = { originator: principalOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(meta, 70, ladder))).toBe('principal');
      expect(role(computeEffectiveTaskMetadata(meta, 89, ladder))).toBe('principal');
      expect(role(computeEffectiveTaskMetadata(meta, 100, ladder))).toBe('principal');
    });

    it('downgrades principal to agent at score < 70 (posture A)', () => {
      const meta = { originator: principalOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(meta, 69, ladder))).toBe('agent');
      expect(role(computeEffectiveTaskMetadata(meta, 0, ladder))).toBe('agent');
    });

    it('keeps system standing at score >= 70', () => {
      const meta = { originator: systemOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(meta, 75, ladder))).toBe('system');
    });
  });

  describe('derived child task (derived: true)', () => {
    const wakeContext = makeWakeContext(true);

    it('downgrades to agent below 90 even at posture B (70–89)', () => {
      const meta = { originator: systemOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(meta, 75, ladder))).toBe('agent');
      expect(role(computeEffectiveTaskMetadata(meta, 89, ladder))).toBe('agent');
    });

    it('keeps lineage at score >= 90 (posture D)', () => {
      const sys = { originator: systemOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(sys, 90, ladder))).toBe('system');
      const prin = { originator: principalOriginator(), wakeContext };
      expect(role(computeEffectiveTaskMetadata(prin, 95, ladder))).toBe('principal');
    });
  });

  it('downgrades on a missing live score (fail-safe) for a wake', () => {
    const meta = { originator: principalOriginator(), wakeContext: makeWakeContext(false) };
    expect(role(computeEffectiveTaskMetadata(meta, null, ladder))).toBe('agent');
  });

  it('leaves an already-agent lineage untouched (nothing to downgrade)', () => {
    const agent: TaskOriginator = {
      contactId: 'agent-id', systemRole: 'agent', channel: 'internal',
      initiatedAt: '2026-06-23T00:00:00.000Z', tier: null,
    };
    const meta = { originator: agent, wakeContext: makeWakeContext(false) };
    expect(computeEffectiveTaskMetadata(meta, 0, ladder)).toBe(meta);
  });

  it('drops the tier when downgrading so Gate C treats it as agent', () => {
    const meta = { originator: principalOriginator(), wakeContext: makeWakeContext(false) };
    const eff = computeEffectiveTaskMetadata(meta, 10, ladder);
    expect((eff?.originator as TaskOriginator).tier).toBeNull();
  });

  it('honours custom ladder thresholds', () => {
    const custom = { sameTaskThreshold: 50, derivedChildThreshold: 80 };
    const meta = { originator: principalOriginator(), wakeContext: makeWakeContext(false) };
    expect(role(computeEffectiveTaskMetadata(meta, 55, custom))).toBe('principal');
    expect(role(computeEffectiveTaskMetadata(meta, 45, custom))).toBe('agent');
  });
});

describe('resolveBypassLadder', () => {
  it('returns the defaults when no override is supplied', () => {
    expect(resolveBypassLadder()).toEqual(DEFAULT_BYPASS_LADDER);
    expect(resolveBypassLadder({})).toEqual(DEFAULT_BYPASS_LADDER);
  });

  it('applies a valid override', () => {
    expect(resolveBypassLadder({ same_task: 65, derived_child: 95 })).toEqual({
      sameTaskThreshold: 65,
      derivedChildThreshold: 95,
    });
  });

  it('fills only the supplied field from defaults', () => {
    expect(resolveBypassLadder({ same_task: 80 })).toEqual({ sameTaskThreshold: 80, derivedChildThreshold: 90 });
  });

  it('throws when same_task drops below the restricted-mode floor (60)', () => {
    expect(() => resolveBypassLadder({ same_task: 30 })).toThrow(/bypass_ladder/);
  });

  it('throws when the ladder is inverted (derived_child < same_task)', () => {
    expect(() => resolveBypassLadder({ same_task: 90, derived_child: 70 })).toThrow(/bypass_ladder/);
  });

  it('throws on out-of-range or non-integer thresholds', () => {
    expect(() => resolveBypassLadder({ derived_child: 120 })).toThrow();
    expect(() => resolveBypassLadder({ same_task: 70.5 })).toThrow();
  });
});
