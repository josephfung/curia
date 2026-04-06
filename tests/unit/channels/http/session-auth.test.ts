import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { assertSecret, type SessionStore } from '../../../../src/channels/http/session-auth.js';

// Helper: build a minimal FastifyRequest with optional session cookie and optional secret header.
function makeRequest(opts: {
  secretHeader?: string;
  sessionToken?: string;
}): FastifyRequest {
  return {
    headers: opts.secretHeader ? { 'x-web-bootstrap-secret': opts.secretHeader } : {},
    cookies: opts.sessionToken ? { curia_session: opts.sessionToken } : undefined,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { statusCode: number; body: unknown } {
  const reply = { statusCode: 0, body: undefined as unknown };
  (reply as unknown as FastifyReply).status = (n: number) => ({
    send: (b: unknown) => { reply.statusCode = n; reply.body = b; },
  }) as unknown as FastifyReply;
  return reply as unknown as FastifyReply & { statusCode: number; body: unknown };
}

describe('assertSecret', () => {
  const configuredSecret = 'correct-secret';
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = new Map();
  });

  it('accepts a valid x-web-bootstrap-secret header', () => {
    const request = makeRequest({ secretHeader: 'correct-secret' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(true);
  });

  it('rejects an invalid x-web-bootstrap-secret header', () => {
    const request = makeRequest({ secretHeader: 'wrong-secret' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('accepts a valid session cookie', () => {
    const token = 'valid-token-abc';
    sessions.set(token, Date.now() + 60_000);
    const request = makeRequest({ sessionToken: token });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(true);
  });

  it('rejects an expired session cookie', () => {
    const token = 'expired-token';
    sessions.set(token, Date.now() - 1000);
    const request = makeRequest({ sessionToken: token });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('rejects an unknown session cookie', () => {
    const request = makeRequest({ sessionToken: 'unknown-token' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, configuredSecret, sessions)).toBe(false);
    expect(reply.statusCode).toBe(401);
  });

  it('returns 503 when no configured secret is provided', () => {
    const request = makeRequest({ secretHeader: 'anything' });
    const reply = makeReply();
    expect(assertSecret(request, reply as unknown as FastifyReply, undefined, sessions)).toBe(false);
    expect(reply.statusCode).toBe(503);
  });
});
