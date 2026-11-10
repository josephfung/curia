// Shape checks for the conferencing input on calendar create/update (#2536).
// The failing inputs are the ones the calendar agent sent Nylas in production.

import { describe, it, expect } from 'vitest';
import { parseConferencing } from '../../../../src/channels/calendar/conferencing-input.js';

function expectError(raw: unknown): string {
  const result = parseConferencing(raw);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.conferencing)}`);
  return result.error;
}

describe('parseConferencing', () => {
  describe('auto-created links', () => {
    it('turns autocreate: true into the empty object Nylas requires', () => {
      expect(parseConferencing({ provider: 'Google Meet', autocreate: true })).toEqual({
        ok: true,
        conferencing: { provider: 'Google Meet', autocreate: {} },
      });
    });

    it('accepts the Nylas form autocreate: {} unchanged', () => {
      expect(parseConferencing({ provider: 'Microsoft Teams', autocreate: {} })).toEqual({
        ok: true,
        conferencing: { provider: 'Microsoft Teams', autocreate: {} },
      });
    });

    it.each([
      ['Meet', 'Google Meet'],
      ['google meet', 'Google Meet'],
      ['  GOOGLE MEET ', 'Google Meet'],
      ['Teams', 'Microsoft Teams'],
      ['microsoft teams', 'Microsoft Teams'],
    ])('maps provider alias %j to %j', (alias, canonical) => {
      expect(parseConferencing({ provider: alias, autocreate: true })).toEqual({
        ok: true,
        conferencing: { provider: canonical, autocreate: {} },
      });
    });

    it.each(['Zoom', 'zoom', 'Zoom Meeting'])('refuses to auto-create %j and says why', (provider) => {
      const error = expectError({ provider, autocreate: true });
      expect(error).toContain('no Zoom account is connected');
      expect(error).toContain('details');
    });

    it('refuses a Zoom grant id supplied by the caller, since none is configured', () => {
      expect(expectError({ provider: 'Zoom Meeting', autocreate: { conf_grant_id: 'guessed' } }))
        .toContain('no Zoom account is connected');
    });

    it.each(['GoToMeeting', 'WebEx'])('refuses to auto-create %j, naming what can be', (provider) => {
      const error = expectError({ provider, autocreate: true });
      expect(error).toContain('Google Meet');
      expect(error).toContain('Microsoft Teams');
    });

    it('refuses autocreate settings it would otherwise forward unchecked', () => {
      expect(expectError({ provider: 'Google Meet', autocreate: { settings: { x: 1 } } })).toContain('autocreate');
    });
  });

  describe('existing links', () => {
    it('passes details through with the provider normalized', () => {
      const details = { url: 'https://zoom.example/j/123', password: 'pw' };
      expect(parseConferencing({ provider: 'Zoom', details })).toEqual({
        ok: true,
        conferencing: { provider: 'Zoom Meeting', details },
      });
    });

    it('treats autocreate: false as absent when details are present', () => {
      const details = { url: 'https://meet.example/abc' };
      expect(parseConferencing({ provider: 'Meet', autocreate: false, details })).toEqual({
        ok: true,
        conferencing: { provider: 'Google Meet', details },
      });
    });

    it('accepts providers that can only be attached, not auto-created', () => {
      const details = { url: 'https://webex.example/m/1' };
      expect(parseConferencing({ provider: 'webex', details })).toEqual({
        ok: true,
        conferencing: { provider: 'WebEx', details },
      });
    });

    it.each([
      [{}], ['https://x.example'], [null], [[]],
      [{ link: 'https://x.example' }], [{ url: '' }], [{ url: '   ' }], [{ url: 42 }], [{ password: 'pw' }],
    ])('refuses details of %j', (details) => {
      expect(expectError({ provider: 'Google Meet', details })).toContain('details');
    });

    it('trims the url', () => {
      expect(parseConferencing({ provider: 'Zoom', details: { url: ' https://x.example ', password: 'pw' } })).toEqual({
        ok: true,
        conferencing: { provider: 'Zoom Meeting', details: { url: 'https://x.example', password: 'pw' } },
      });
    });
  });

  describe('malformed input', () => {
    it.each([['Google Meet'], [true], [[]]])('refuses a non-object %j', (raw) => {
      expect(expectError(raw)).toContain('conferencing must be an object');
    });

    it('refuses null with a message that says removal is unsupported', () => {
      const error = expectError(null);
      expect(error).toContain('removing a video link is not supported');
      expect(error).toContain('Nothing was created or changed');
    });

    it('requires a provider', () => {
      expect(expectError({ autocreate: true })).toContain('provider');
    });

    it('refuses an unknown provider, listing the accepted ones', () => {
      const error = expectError({ provider: 'Skype', autocreate: true });
      expect(error).toContain('"Skype"');
      expect(error).toContain('Zoom Meeting');
    });

    it.each(['constructor', '__proto__'])('treats inherited property name %j as an unknown provider', (provider) => {
      expect(expectError({ provider, autocreate: true })).toContain('is not supported');
    });

    it.each([
      [{ provider: 'Google Meet' }],
      [{ provider: 'Google Meet', autocreate: false }],
    ])('refuses %j, which asks for neither a new nor an existing link', (raw) => {
      expect(expectError(raw)).toContain('autocreate');
    });

    it('refuses both autocreate and details', () => {
      expect(expectError({ provider: 'Google Meet', autocreate: true, details: { url: 'https://x.example' } }))
        .toContain('not both');
    });

    it('refuses a non-boolean, non-object autocreate', () => {
      expect(expectError({ provider: 'Google Meet', autocreate: 'yes' })).toContain('autocreate');
    });

    it('refuses fields it does not know rather than dropping them', () => {
      expect(expectError({ provider: 'Google Meet', autocreate: true, url: 'https://x.example' })).toContain('url');
    });
  });
});
