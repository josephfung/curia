import { describe, it, expect } from 'vitest';
import { sourceKeyFor, sourceKeysInText } from '../../../src/contacts/identifier-provenance.js';

function found(text: string, channel: string, identifier: string): boolean {
  return sourceKeysInText(text).has(sourceKeyFor(channel, identifier));
}

describe('identifier provenance — email', () => {
  it('finds an address in prose, JSON, angle brackets and a mailto link', () => {
    expect(found('Email sam@venue-co.com about the room', 'email', 'sam@venue-co.com')).toBe(true);
    expect(found('{"from":[{"name":"Sam","email":"sam@venue-co.com"}]}', 'email', 'sam@venue-co.com')).toBe(true);
    expect(found('Sam Rivera <sam@venue-co.com>', 'email', 'sam@venue-co.com')).toBe(true);
    expect(found('<a href="mailto:sam@venue-co.com">', 'email', 'sam@venue-co.com')).toBe(true);
  });

  it('ignores trailing punctuation and case', () => {
    expect(found('Please email Sam@Venue-Co.com.', 'email', 'sam@venue-co.com')).toBe(true);
    expect(found('reach me at sam@venue-co.com, thanks', 'email', 'SAM@venue-co.com')).toBe(true);
  });

  it('does not find a near miss', () => {
    expect(found('Email sam@venue-co.com', 'email', 'sam@venu-co.com')).toBe(false);
    expect(found('Email sam@venue-co.com', 'email', 'sam@venue-co.ca')).toBe(false);
  });
});

describe('identifier provenance — phone', () => {
  it('finds a number written in local or international form', () => {
    for (const text of ['call 416-555-0100', 'call (416) 555-0100', 'call +1 416 555 0100', 'call 1-416-555-0100']) {
      expect(found(text, 'phone', '+14165550100')).toBe(true);
    }
  });

  it('finds an international number and matches signal and sms channels', () => {
    expect(found('Office: +44 20 7946 0958', 'phone', '+442079460958')).toBe(true);
    expect(found('text me on +14165550100', 'signal', '+14165550100')).toBe(true);
    expect(found('text me on +14165550100', 'sms', '+1 (416) 555-0100')).toBe(true);
  });

  it('does not find a number one digit off', () => {
    expect(found('call 416-555-0100', 'phone', '+14165550101')).toBe(false);
  });
});

describe('identifier provenance — other channels', () => {
  it('finds a Slack user id as a whole token', () => {
    expect(found('Her Slack id is U012AB3CD.', 'slack', 'U012AB3CD')).toBe(true);
    expect(found('Her Slack id is U012AB3CDX', 'slack', 'U012AB3CD')).toBe(false);
  });
});
