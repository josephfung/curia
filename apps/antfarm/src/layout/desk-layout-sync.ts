import { deskLayoutKey, type DeskSlot } from './desk-layout.js';

export interface DeskSyncState {
  lastKey: string;
}

/**
 * Apply a desk-roster update to the Phaser scene when it is active.
 *
 * Returns:
 * - `waiting` — scene not active yet; caller must retry on wake (do NOT record
 *   the key as applied — that is the scene-boot race in #1549)
 * - `noop` — scene active and roster unchanged
 * - `applied` — `apply` was invoked and `state.lastKey` advanced
 */
export function applyDeskLayoutSync(
  state: DeskSyncState,
  desks: DeskSlot[],
  sceneActive: boolean,
  apply: (desks: DeskSlot[]) => void,
): 'applied' | 'waiting' | 'noop' {
  if (!sceneActive) return 'waiting';
  const key = deskLayoutKey(desks);
  if (key === state.lastKey) return 'noop';
  state.lastKey = key;
  apply(desks);
  return 'applied';
}
