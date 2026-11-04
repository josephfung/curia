import { describe, it, expect } from 'vitest';
import { breakingDeclarers, declarerLabel, removeConfirmation, type SecretRowData } from './secrets-utils.js';

const row = (declaredBy: SecretRowData['declaredBy']): SecretRowData => ({
  name: 'k', configured: true, required: declaredBy.some(d => d.required), declaredBy,
});

describe('secrets-utils', () => {
  it('labels declarers by kind', () => {
    expect(declarerLabel({ kind: 'tool', name: 'web-search', required: false, enabled: true })).toBe('Tool web-search');
    expect(declarerLabel({ kind: 'principal-mailbox', name: 'Principal mailbox', required: false, enabled: true })).toBe('Principal mailbox');
  });

  it('only enabled, required declarers break on removal', () => {
    const r = row([
      { kind: 'tool', name: 'on', required: true, enabled: true },
      { kind: 'tool', name: 'off', required: true, enabled: false },
      { kind: 'tool', name: 'opt', required: false, enabled: true },
    ]);
    expect(breakingDeclarers(r).map(d => d.name)).toEqual(['on']);
    expect(removeConfirmation(r)).toBe('Remove k? Tool on will stop working until it is set again.');
  });

  it('asks a plain question when nothing breaks', () => {
    expect(removeConfirmation(row([{ kind: 'tool', name: 'opt', required: false, enabled: true }]))).toBe('Remove k?');
  });
});
