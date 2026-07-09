// Unit tests for Ant Farm HTTP routes — error sanitization and SSE client cleanup.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antfarmRoutes } from '../../../../src/channels/http/routes/antfarm.js';
import type { AuditLogRepo } from '../../../../src/audit/audit-log-repo.js';
import type { EventRouter } from '../../../../src/channels/http/event-router.js';
import type { Logger } from '../../../../src/logger.js';

const TEST_SECRET = 'test-antfarm-secret';
const AUTH_HEADER = { 'x-web-bootstrap-secret': TEST_SECRET };

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('antfarm routes', () => {
  describe('GET /api/antfarm/timeline', () => {
    it('returns a generic 500 body when the timeline query fails', async () => {
      const sensitiveMessage = 'relation "audit_log" does not exist at character 42';
      const auditLogRepo = {
        findTimeline: vi.fn().mockRejectedValue(new Error(sensitiveMessage)),
      } as unknown as AuditLogRepo;
      const logger = createLogger();
      const app = Fastify();

      await app.register(antfarmRoutes, {
        auditLogRepo,
        eventRouter: { addAntfarmClient: vi.fn().mockReturnValue(() => {}) } as unknown as EventRouter,
        webAppBootstrapSecret: TEST_SECRET,
        sessions: new Map(),
        logger,
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/antfarm/timeline?conversationId=conv-1',
        headers: AUTH_HEADER,
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe('Failed to load timeline');
      expect(body.error).not.toContain('audit_log');
      expect(body.error).not.toContain('character 42');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'antfarm timeline query failed',
      );

      await app.close();
    });
  });

  describe('GET /api/antfarm/stream heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes the antfarm client when a heartbeat write fails', async () => {
      const cleanup = vi.fn();
      const logger = createLogger();
      const eventRouter = {
        addAntfarmClient: vi.fn().mockImplementation((client: { res: { write: (...args: unknown[]) => boolean } }) => {
          const originalWrite = client.res.write.bind(client.res);
          vi.spyOn(client.res, 'write').mockImplementation((chunk: unknown, ...args: unknown[]) => {
            if (typeof chunk === 'string' && chunk.startsWith(':ping')) {
              throw new Error('broken pipe');
            }
            return originalWrite(chunk, ...args);
          });
          return cleanup;
        }),
      } as unknown as EventRouter;
      const app = Fastify();

      await app.register(antfarmRoutes, {
        auditLogRepo: { findTimeline: vi.fn() } as unknown as AuditLogRepo,
        eventRouter,
        webAppBootstrapSecret: TEST_SECRET,
        sessions: new Map(),
        logger,
      });
      await app.ready();
      await app.listen({ port: 0, host: '127.0.0.1' });

      const addr = app.server.address() as AddressInfo;
      const connected = new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: '/api/antfarm/stream',
            headers: AUTH_HEADER,
          },
          () => resolve(),
        );
        req.on('error', () => resolve());
        req.end();
      });

      await connected;
      expect(eventRouter.addAntfarmClient).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(30000);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Ant Farm SSE heartbeat write failed — removing client',
      );

      await app.close();
    });
  });
});
