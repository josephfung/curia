import { describe, expect, it } from 'vitest';
import { nextMenuIndex } from './user-menu-keys.js';

describe('nextMenuIndex', () => {
  it('moves with the arrows and wraps at both ends', () => {
    expect(nextMenuIndex('ArrowDown', 0, 5)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 4, 5)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 5)).toBe(4);
    expect(nextMenuIndex('ArrowUp', 3, 5)).toBe(2);
  });

  it('starts at the top or bottom when nothing in the menu has focus', () => {
    expect(nextMenuIndex('ArrowDown', -1, 5)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 5)).toBe(4);
  });

  it('jumps with Home and End, and ignores other keys and an empty menu', () => {
    expect(nextMenuIndex('Home', 3, 5)).toBe(0);
    expect(nextMenuIndex('End', 1, 5)).toBe(4);
    expect(nextMenuIndex('a', 1, 5)).toBeNull();
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBeNull();
  });
});
