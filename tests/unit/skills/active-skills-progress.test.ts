import { describe, it, expect } from 'vitest';
import {
  activateSkillInBlock,
  prepareActiveSkillsBlock,
  readActiveSkillNames,
  readActiveSkillsBlock,
  replaceActiveSkillsBlock,
  reconcileActiveSkillsBlock,
  activeSkillNameSetsEqual,
  ACTIVE_SKILLS_CAP,
} from '../../../src/db/active-skills-progress.js';

describe('active-skills-progress', () => {
  it('reads a valid block', () => {
    const block = readActiveSkillsBlock({
      activeSkills: {
        skills: [
          { name: 'tasks', activatedAt: '2026-07-21T00:00:00.000Z' },
          { name: 'calendar', activatedAt: '2026-07-21T01:00:00.000Z' },
        ],
      },
    });
    expect(block?.skills.map((s) => s.name)).toEqual(['tasks', 'calendar']);
    expect(readActiveSkillNames({ activeSkills: block })).toEqual(['tasks', 'calendar']);
  });

  it('returns null for malformed blocks', () => {
    expect(readActiveSkillsBlock({})).toBeNull();
    expect(readActiveSkillsBlock({ activeSkills: { skills: [{ name: 'x' }] } })).toBeNull();
  });

  it('activates MRU and caps the set', () => {
    let block = activateSkillInBlock(null, 'a', '2026-07-21T00:00:00.000Z', 3);
    block = activateSkillInBlock(block, 'b', '2026-07-21T01:00:00.000Z', 3);
    block = activateSkillInBlock(block, 'c', '2026-07-21T02:00:00.000Z', 3);
    block = activateSkillInBlock(block, 'd', '2026-07-21T03:00:00.000Z', 3);
    expect(block.skills.map((s) => s.name)).toEqual(['d', 'c', 'b']);
    expect(ACTIVE_SKILLS_CAP).toBe(5);
  });

  it('re-activating moves a skill to the front', () => {
    let block = activateSkillInBlock(null, 'a', '2026-07-21T00:00:00.000Z');
    block = activateSkillInBlock(block, 'b', '2026-07-21T01:00:00.000Z');
    block = activateSkillInBlock(block, 'a', '2026-07-21T02:00:00.000Z');
    expect(block.skills.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('replaceActiveSkillsBlock dedupes and caps', () => {
    const block = replaceActiveSkillsBlock(['tasks', 'tasks', 'calendar', 'x', 'y', 'z'], 't', 3);
    expect(block.skills.map((s) => s.name)).toEqual(['tasks', 'calendar', 'x']);
  });

  it('reconcileActiveSkillsBlock preserves activatedAt for survivors', () => {
    const existing = {
      skills: [
        { name: 'tasks', activatedAt: '2026-07-21T00:00:00.000Z' },
        { name: 'calendar', activatedAt: '2026-07-21T01:00:00.000Z' },
      ],
    };
    const next = reconcileActiveSkillsBlock(
      ['calendar', 'email'],
      existing,
      '2026-07-22T12:00:00.000Z',
    );
    expect(next.skills).toEqual([
      { name: 'calendar', activatedAt: '2026-07-21T01:00:00.000Z' },
      { name: 'email', activatedAt: '2026-07-22T12:00:00.000Z' },
    ]);
  });

  it('activeSkillNameSetsEqual is order-independent', () => {
    expect(activeSkillNameSetsEqual(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(activeSkillNameSetsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('activeSkillNameSetsEqual compares unique membership, not array length', () => {
    // Equal length but different sets — duplicates must not mask a real difference.
    expect(activeSkillNameSetsEqual(['x', 'x'], ['x', 'y'])).toBe(false);
    // Same set, differing duplicate counts — still equal.
    expect(activeSkillNameSetsEqual(['x', 'x', 'y'], ['x', 'y'])).toBe(true);
  });

  it('prepareActiveSkillsBlock rejects overflow', () => {
    const huge = activateSkillInBlock(null, 'x'.repeat(5000), 't');
    const prepared = prepareActiveSkillsBlock(huge);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.code).toBe('block_overflow');
  });
});
