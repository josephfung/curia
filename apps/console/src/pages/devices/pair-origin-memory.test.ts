import { describe, expect, it } from 'vitest';
import { readPairingOrigin, writePairingOrigin, PAIRING_ORIGIN_KEY } from './pair-origin-memory.js';

describe('pairing origin memory', () => {
  it('remembers a typed origin and ignores a storage that throws', () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    };
    writePairingOrigin(storage, 'https://curia.example.com');
    expect(saved.get(PAIRING_ORIGIN_KEY)).toBe('https://curia.example.com');
    expect(readPairingOrigin(storage)).toBe('https://curia.example.com');
    const blocked = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(readPairingOrigin(blocked)).toBe('');
    expect(() => writePairingOrigin(blocked, 'https://curia.example.com')).not.toThrow();
  });
});
