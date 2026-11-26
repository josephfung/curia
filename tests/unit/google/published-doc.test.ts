import { describe, it, expect } from 'vitest';
import { readPublishedDocRecord } from '../../../src/google/published-doc.js';

const RECORD = {
  id: 'gdoc-1',
  url: 'https://docs.google.com/document/d/gdoc-1/edit',
  published_at: '2026-11-25T15:00:00.000Z',
  content_hash: '3f2a9c1e0b7d4a55',
};

describe('readPublishedDocRecord', () => {
  it('returns no record when the key is absent or null', () => {
    expect(readPublishedDocRecord(undefined)).toEqual({ record: null });
    expect(readPublishedDocRecord({ title: 'x' })).toEqual({ record: null });
    expect(readPublishedDocRecord({ google_doc: null })).toEqual({ record: null });
  });

  it('returns a well-formed record, dropping unknown fields', () => {
    expect(readPublishedDocRecord({ google_doc: { ...RECORD, extra: 1 } })).toEqual({ record: RECORD });
  });

  it('flags a value that is not a complete record', () => {
    expect(readPublishedDocRecord({ google_doc: 'gdoc-1' })).toEqual({ invalid: true });
    expect(readPublishedDocRecord({ google_doc: [RECORD] })).toEqual({ invalid: true });
    expect(readPublishedDocRecord({ google_doc: { ...RECORD, content_hash: '' } })).toEqual({ invalid: true });
    expect(readPublishedDocRecord({ google_doc: { ...RECORD, url: undefined } })).toEqual({ invalid: true });
  });
});
