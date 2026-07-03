import { describe, it, expect, beforeEach } from 'vitest';
import { loadBookmarks, saveBookmarks, addBookmark, removeBookmark } from './bookmarks.js';

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, value); },
  };
}

describe('bookmarks', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: makeStorage(),
      configurable: true,
    });
  });

  it('persists and reloads bookmarks', () => {
    addBookmark({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-01T01:00:00.000Z',
      label: 'Morning demo',
      conversationId: 'conv-1',
    });
    const loaded = loadBookmarks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.label).toBe('Morning demo');
  });

  it('removes a bookmark by index', () => {
    saveBookmarks([
      { from: 'a', to: 'b', label: 'one' },
      { from: 'c', to: 'd', label: 'two' },
    ]);
    const next = removeBookmark(0);
    expect(next).toHaveLength(1);
    expect(next[0]!.label).toBe('two');
    expect(loadBookmarks()).toHaveLength(1);
  });
});
