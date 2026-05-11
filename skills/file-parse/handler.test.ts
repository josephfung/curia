import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses a simple CSV into typed rows', () => {
    const csv = 'date,description,amount\n2026-01-15,OpenAI,20.00\n2026-01-16,Figma,15.00';
    const result = parseCsv(csv);
    expect(result).toEqual([
      { date: '2026-01-15', description: 'OpenAI', amount: '20.00' },
      { date: '2026-01-16', description: 'Figma', amount: '15.00' },
    ]);
  });

  it('handles quoted fields with commas', () => {
    const csv = 'vendor,description,amount\n"Acme, Inc.","Widget, large",99.99';
    const result = parseCsv(csv);
    expect(result).toEqual([
      { vendor: 'Acme, Inc.', description: 'Widget, large', amount: '99.99' },
    ]);
  });

  it('handles empty fields', () => {
    const csv = 'a,b,c\n1,,3';
    const result = parseCsv(csv);
    expect(result).toEqual([{ a: '1', b: '', c: '3' }]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('returns empty array for header-only CSV', () => {
    expect(parseCsv('a,b,c')).toEqual([]);
  });

  it('trims whitespace from headers and values', () => {
    const csv = ' name , value \n Alice , 42 ';
    const result = parseCsv(csv);
    expect(result).toEqual([{ name: 'Alice', value: '42' }]);
  });
});
