import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  memoryRetentionRoutes,
  resolveMemoryRetentionSnapshot,
  type MemoryRetentionSnapshot,
} from '../../../../src/channels/http/routes/memory-retention.js';
import { hashToken } from '../../../../src/channels/http/session-auth.js';

const SECRET = 'test-bootstrap-secret';

const SNAPSHOT: MemoryRetentionSnapshot = {
  workingMemoryTtlDays: 30,
  scratchTtlDays: 7,
  archiveThreshold: 0.05,
  halfLifeDays: { slowDecay: 180, fastDecay: 21 },
  warnHoldBackDays: 7,
  editable: false,
};

describe('resolveMemoryRetentionSnapshot', () => {
  it('applies defaults when yaml omits retention keys', () => {
    expect(resolveMemoryRetentionSnapshot({})).toEqual(SNAPSHOT);
  });

  it('passes through configured values', () => {
    const resolved = resolveMemoryRetentionSnapshot({
      workingMemory: { ttlDays: 14 },
      documentWorkspace: { scratchTtlDays: 3 },
      dreaming: {
        decay: {
          archiveThreshold: 0.1,
          halfLifeDays: { slow_decay: 90, fast_decay: 14 },
          warnHoldBackDays: 3,
        },
      },
    });
    expect(resolved.workingMemoryTtlDays).toBe(14);
    expect(resolved.scratchTtlDays).toBe(3);
    expect(resolved.archiveThreshold).toBe(0.1);
    expect(resolved.halfLifeDays.slowDecay).toBe(90);
    expect(resolved.halfLifeDays.fastDecay).toBe(14);
    expect(resolved.warnHoldBackDays).toBe(3);
    expect(resolved.editable).toBe(false);
  });
});

describe('GET /api/memory/retention', () => {
  const sessions = new Map<string, number>();

  beforeEach(() => sessions.clear());

  async function buildApp() {
    const app = Fastify();
    await app.register(cookie);
    await app.register(memoryRetentionRoutes, {
      retention: SNAPSHOT,
      webAppBootstrapSecret: SECRET,
      sessions,
    });
    return app;
  }

  it('returns the boot-time retention snapshot', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/retention',
      headers: { 'x-web-bootstrap-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retention: SNAPSHOT });
    await app.close();
  });

  it('accepts a valid session cookie', async () => {
    const token = 'valid-session-token';
    sessions.set(hashToken(token), Date.now() + 60_000);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/retention',
      headers: { cookie: `curia_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects unauthenticated requests', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/retention',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
