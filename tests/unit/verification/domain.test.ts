import { describe, it, expect } from 'vitest';
import { registrableDomain, sameRegistrableDomain } from '../../../src/verification/domain.js';

describe('registrableDomain', () => {
  it('returns the registrable domain for a URL', () => {
    expect(registrableDomain('https://login.aircanada.com/x')).toBe('aircanada.com');
  });

  it('treats b2clogin.com as the registrable domain (not the tenant label)', () => {
    expect(registrableDomain('manulife.b2clogin.com')).toBe('b2clogin.com');
  });

  it('lowercases the result', () => {
    expect(registrableDomain('https://Login.AirCanada.COM/')).toBe('aircanada.com');
  });

  it('handles multi-label public suffixes', () => {
    expect(registrableDomain('https://www.example.co.uk/a')).toBe('example.co.uk');
  });

  it('returns null for IP addresses', () => {
    expect(registrableDomain('192.168.1.1')).toBeNull();
    expect(registrableDomain('http://10.0.0.5:8080/login')).toBeNull();
  });

  it('returns null for unparseable input and bare suffixes', () => {
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });
});

describe('sameRegistrableDomain', () => {
  it('is true for subdomain vs apex', () => {
    expect(sameRegistrableDomain('https://a.aircanada.com', 'aircanada.com')).toBe(true);
  });

  it('is false for a lookalike where the target is only a prefix', () => {
    expect(sameRegistrableDomain('aircanada.com.evil.io', 'aircanada.com')).toBe(false);
  });

  it('is false when either side has no registrable domain', () => {
    expect(sameRegistrableDomain('192.168.1.1', '192.168.1.1')).toBe(false);
    expect(sameRegistrableDomain('', 'aircanada.com')).toBe(false);
  });
});
