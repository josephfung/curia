import { describe, expect, it } from 'vitest';
import { stripModelSignOff } from '../../../../src/channels/email/signature.js';

// #2138: the model's own sign-off is dropped so the gateway's signature is the only one.
describe('stripModelSignOff', () => {
  const persona = { displayName: 'Nathan Curia', title: 'Digital EA', emailSignature: 'Nathan Curia\nOffice of the CEO' };
  const signature = 'Nathan Curia\nOffice of the CEO';
  const strip = (body: string) => stripModelSignOff(body, persona, signature);
  const BODY = 'It still just needs a date and time from you.';

  it('drops first name over the signature line (the incident)', () => {
    expect(strip(`${BODY}\n\nNathan\nOffice of the CEO`)).toBe(BODY);
  });

  it('drops name over the persona title', () => {
    expect(strip(`${BODY}\n\nNathan Curia\nDigital EA`)).toBe(BODY);
  });

  it('drops exactly the configured signature', () => {
    expect(strip(`${BODY}\n\nNathan Curia\nOffice of the CEO`)).toBe(BODY);
  });

  it('drops a bare first name, keeping the valediction above it', () => {
    expect(strip(`${BODY}\n\nBest,\nNathan`)).toBe(`${BODY}\n\nBest,`);
  });

  it('drops emphasis, delimiters, dashes and one-line forms', () => {
    expect(strip(`${BODY}\n\n--\n**Nathan Curia**\n*Digital EA*\n`)).toBe(BODY);
    expect(strip(`${BODY}\n\n— Nathan`)).toBe(BODY);
    expect(strip(`${BODY}\n\nNathan Curia, Digital EA`)).toBe(BODY);
    expect(strip(`${BODY}\r\n\r\nNathan Curia | Office of the CEO\r\n`)).toBe(BODY);
  });

  it('leaves a body with no sign-off alone', () => {
    expect(strip(BODY)).toBe(BODY);
    expect(strip(`${BODY}\n\nThanks!`)).toBe(`${BODY}\n\nThanks!`);
  });

  it('leaves a last line that mentions the name in a sentence', () => {
    const body = `${BODY}\n\nNathan will follow up Monday.`;
    expect(strip(body)).toBe(body);
  });

  it('stops at the first line that is not a sign-off', () => {
    expect(strip(`Nathan\n\n${BODY}\n\nNathan`)).toBe(`Nathan\n\n${BODY}`);
  });

  it('leaves a body that is nothing but a sign-off', () => {
    expect(strip('Nathan Curia\nOffice of the CEO')).toBe('Nathan Curia\nOffice of the CEO');
  });
});
