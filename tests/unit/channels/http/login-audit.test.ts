import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, Layer } from '../../../../src/bus/events.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import { knowledgeGraphRoutes } from '../../../../src/channels/http/routes/kg.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';

const SECRET = 'test-bootstrap-secret';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function poolReturningId(calls: string[]): Pool {
  const query = vi.fn(async (sql: string) => {
    calls.push(sql.trim().slice(0, 6));
    if (sql.includes('INSERT')) return { rows: [{ id: SESSION_ID }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return { query } as unknown as Pool;
}

describe('POST /auth login audit', () => {
  async function build(bus: EventBus, calls: string[]) {
    const app = Fastify();
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    const sessions: SessionStore = new Map();
    await app.register(knowledgeGraphRoutes, {
      pool: poolReturningId(calls),
      logger: createSilentLogger(),
      webAppBootstrapSecret: SECRET,
      secureCookies: false,
      contactService: {} as ContactService,
      sessions,
      bus,
    });
    return { app, sessions };
  }

  it('records login after the session is issued and sets the cookie', async () => {
    const calls: string[] = [];
    const published: BusEvent[] = [];
    const bus = {
      async publish(_layer: Layer, event: BusEvent) {
        calls.push('PUBLISH');
        published.push(event);
      },
    } as unknown as EventBus;
    const { app, sessions } = await build(bus, calls);
    const res = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { 'content-type': 'application/json' },
      payload: { secret: SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('curia_session=');
    expect(calls[0]).toBe('INSERT');
    expect(calls[1]).toBe('PUBLISH');
    const event = published[0]!;
    expect(event.type).toBe('operator.session');
    if (event.type === 'operator.session') {
      expect(event.payload).toMatchObject({
        action: 'login',
        stage: 'completed',
        initiatedBy: 'bootstrap_secret',
        sessionId: SESSION_ID,
        kind: 'browser',
      });
      expect(event.payload.actorSessionId).toBeUndefined();
    }
    expect(sessions.size).toBe(1);
    await app.close();
  });

  it('removes the new session and skips the cookie when the login audit fails', async () => {
    const calls: string[] = [];
    const bus = {
      async publish() {
        throw new Error('audit down');
      },
    } as unknown as EventBus;
    const { app, sessions } = await build(bus, calls);
    const res = await app.inject({
      method: 'POST',
      url: '/auth',
      headers: { 'content-type': 'application/json' },
      payload: { secret: SECRET },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sessions.size).toBe(0);
    expect(calls).toEqual(['INSERT', 'DELETE']);
    await app.close();
  });
});
