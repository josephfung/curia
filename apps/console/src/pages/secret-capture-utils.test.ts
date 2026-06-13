import { describe, it, expect } from 'vitest';
import { classifyMetadataResponse, validateSubmitValue } from './secret-capture-utils.js';

describe('classifyMetadataResponse', () => {
  it('renders the form for a valid (200) token', () => {
    expect(classifyMetadataResponse(200, { label: 'Flight password', value_format: 'string' })).toEqual({
      kind: 'form',
      label: 'Flight password',
      valueFormat: 'string',
    });
  });

  it('defaults an unknown value_format to string', () => {
    const view = classifyMetadataResponse(200, { label: null });
    expect(view).toMatchObject({ kind: 'form', valueFormat: 'string' });
  });

  it('carries through a json value_format', () => {
    expect(classifyMetadataResponse(200, { label: 'creds', value_format: 'json' })).toMatchObject({
      kind: 'form',
      valueFormat: 'json',
    });
  });

  it('shows an expired/used message for 410', () => {
    expect(classifyMetadataResponse(410, null)).toEqual({ kind: 'gone' });
  });

  it('shows a not-found message for 404', () => {
    expect(classifyMetadataResponse(404, null)).toEqual({ kind: 'notfound' });
  });

  it('falls back to a generic error for 5xx', () => {
    expect(classifyMetadataResponse(500, null)).toEqual({ kind: 'error' });
  });
});

describe('validateSubmitValue', () => {
  it('rejects an empty value', () => {
    expect(validateSubmitValue('', 'string')).toMatchObject({ ok: false });
  });

  it('accepts any non-empty string for a string link', () => {
    expect(validateSubmitValue('hunter2', 'string')).toEqual({ ok: true });
  });

  it('rejects malformed JSON for a json link', () => {
    expect(validateSubmitValue('not json', 'json')).toMatchObject({ ok: false });
  });

  it('accepts well-formed JSON for a json link', () => {
    expect(validateSubmitValue('{"a":1}', 'json')).toEqual({ ok: true });
  });
});
