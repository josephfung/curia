import { describe, it, expect } from 'vitest';
import { readPublishedDocRecord } from '../../../src/google/published-doc.js';

const RECORD = {
  id: 'gdoc-1',
  url: 'https://docs.google.com/document/d/gdoc-1/edit',
  published_at: '2026-11-25T15:00:00.000Z',
  modified_time: '2026-11-25T15:00:01.000Z',
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
    expect(readPublishedDocRecord({ google_doc: { ...RECORD, modified_time: '' } })).toEqual({ invalid: true });
    expect(readPublishedDocRecord({ google_doc: { ...RECORD, url: undefined } })).toEqual({ invalid: true });
  });
});
