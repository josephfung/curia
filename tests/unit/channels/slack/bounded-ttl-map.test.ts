import { describe, it, expect } from 'vitest';
import { BoundedTtlMap } from '../../../../src/channels/slack/bounded-ttl-map.js';

describe('BoundedTtlMap', () => {
  it('expires entries after TTL', () => {
    const map = new BoundedTtlMap<string>(1000, 10);
    map.set('a', 'alice', 0);
    expect(map.get('a', 500)).toBe('alice');
    expect(map.get('a', 1500)).toBeUndefined();
  });

  it('evicts oldest when over max size', () => {
    const map = new BoundedTtlMap<string>(60_000, 2);
    map.set('a', '1', 0);
    map.set('b', '2', 1);
    map.set('c', '3', 2);
    expect(map.has('a', 3)).toBe(false);
    expect(map.get('b', 3)).toBe('2');
    expect(map.get('c', 3)).toBe('3');
  });

  it('get refreshes LRU order so hot keys survive eviction', () => {
    const map = new BoundedTtlMap<string>(60_000, 2);
    map.set('a', '1', 0);
    map.set('b', '2', 1);
    expect(map.get('a', 2)).toBe('1'); // touch a → newer than b
    map.set('c', '3', 3);
    expect(map.has('b', 4)).toBe(false);
    expect(map.get('a', 4)).toBe('1');
    expect(map.get('c', 4)).toBe('3');
  });
});
