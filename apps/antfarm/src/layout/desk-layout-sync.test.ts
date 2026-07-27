import { describe, it, expect, vi } from 'vitest';
import { applyDeskLayoutSync, type DeskSyncState } from './desk-layout-sync.js';
import { deskLayoutKey, type DeskSlot } from './desk-layout.js';

const COORD_ONLY: DeskSlot[] = [{ agentId: 'coordinator', row: 'boss', column: 0 }];
const FULL_ROSTER: DeskSlot[] = [
  { agentId: 'coordinator', row: 'boss', column: 0 },
  { agentId: 'research', row: 'floor', column: 0 },
  { agentId: 'calendar', row: 'floor', column: 1 },
];

describe('applyDeskLayoutSync (#1549 scene-boot race)', () => {
  it('returns waiting without advancing lastKey when the scene is inactive', () => {
    const state: DeskSyncState = { lastKey: '' };
    const apply = vi.fn();
    expect(applyDeskLayoutSync(state, FULL_ROSTER, false, apply)).toBe('waiting');
    expect(apply).not.toHaveBeenCalled();
    expect(state.lastKey).toBe('');
  });

  it('applies a pending roster once the scene becomes active (boot-race regression)', () => {
    const state: DeskSyncState = { lastKey: '' };
    const apply = vi.fn();

    // Mid-boot: registry fetch lands while OfficeScene is not yet active.
    expect(applyDeskLayoutSync(state, FULL_ROSTER, false, apply)).toBe('waiting');
    expect(apply).not.toHaveBeenCalled();

    // Scene wakes — same desks must now flush (the bug was dropping this update).
    expect(applyDeskLayoutSync(state, FULL_ROSTER, true, apply)).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(FULL_ROSTER);
    expect(state.lastKey).toBe(deskLayoutKey(FULL_ROSTER));
  });

  it('noops when the active scene already has the same roster', () => {
    const state: DeskSyncState = { lastKey: deskLayoutKey(COORD_ONLY) };
    const apply = vi.fn();
    expect(applyDeskLayoutSync(state, COORD_ONLY, true, apply)).toBe('noop');
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies when the active scene roster changes', () => {
    const state: DeskSyncState = { lastKey: deskLayoutKey(COORD_ONLY) };
    const apply = vi.fn();
    expect(applyDeskLayoutSync(state, FULL_ROSTER, true, apply)).toBe('applied');
    expect(apply).toHaveBeenCalledWith(FULL_ROSTER);
    expect(state.lastKey).toBe(deskLayoutKey(FULL_ROSTER));
  });
});
