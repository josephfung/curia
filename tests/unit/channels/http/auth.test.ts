import { describe, it, expect } from 'vitest';
import { bypassesBearerAuth, validateBearerToken } from '../../../../src/channels/http/auth.js';

describe('validateBearerToken', () => {
  it('returns true for a valid token', () => {
    expect(validateBearerToken('Bearer my-secret-token', 'my-secret-token')).toBe(true);
  });

  it('returns false for an invalid token', () => {
    expect(validateBearerToken('Bearer wrong-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for missing Bearer prefix', () => {
    expect(validateBearerToken('my-secret-token', 'my-secret-token')).toBe(false);
  });

  it('returns false for empty authorization header', () => {
    expect(validateBearerToken('', 'my-secret-token')).toBe(false);
  });

  it('returns false for undefined authorization header', () => {
    expect(validateBearerToken(undefined, 'my-secret-token')).toBe(false);
  });

  it('returns true when no API token is configured (auth disabled)', () => {
    expect(validateBearerToken(undefined, undefined)).toBe(true);
  });

  it('returns true for any header when no API token is configured', () => {
    expect(validateBearerToken('Bearer anything', undefined)).toBe(true);
  });

  it('returns false for "Bearer " with no token value', () => {
    expect(validateBearerToken('Bearer ', 'my-secret-token')).toBe(false);
  });
});

describe('bypassesBearerAuth', () => {
  // Every console route that authenticates with the session cookie must be here, or the
  // adapter's hook 401s the browser before assertSecret runs (#2285 shipped /api/activity without it).
  it.each([
    '/api/health',
    '/api/activity',
    '/api/dashboard/waiting',
    '/api/jobs',
    '/api/jobs/:jobId',
    '/api/antfarm/timeline',
    '/api/kg/nodes',
    '/api/tasks',
    '/api/contacts',
    '/api/chat/messages',
    '/api/sessions',
    '/api/sessions/:id',
    '/api/grant-recommendations',
    '/api/identity/me',
    '/api/setup/status',
    '/api/secret-capture/:token',
    '/api/webhooks/telnyx/sms',
  ])('lets %s through to its own auth', (url) => {
    expect(bypassesBearerAuth(url)).toBe(true);
  });

  it.each([
    '/api/agents/status',
    '/api/healthz',
    '/api/nonexistent',
    // Prefixes must not match on a shared leading substring (#872 review).
    '/api/chat-export',
    '/api/sessions-export',
    '/api/tasks-summary',
    '/api/contacts.csv',
    '/*',
  ])('enforces bearer auth on %s', (url) => {
    expect(bypassesBearerAuth(url)).toBe(false);
  });
});
