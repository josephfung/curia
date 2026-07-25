import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import type { ContactService } from '../../contacts/contact-service.js';
import { voiceSessionRoutes } from './session-routes.js';
import { VoiceSessionBridge } from './session-bridge.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };
const logger = pino({ level: 'silent' });

function contactService(): ContactService {
  return {
    findContactBySystemRole: vi.fn().mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
    }),
  } as unknown as ContactService;
}

async function build(bridge: VoiceSessionBridge): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(voiceSessionRoutes, {
    bridge,
    logger,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
    contactService: contactService(),
  });
  return app;
}

describe('VoiceSessionBridge routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('reports disabled and returns 503 for create when no handler is installed', async () => {
    app = await build(new VoiceSessionBridge());

    const status = await app.inject({ method: 'GET', url: '/api/voice/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false });

    const create = await app.inject({ method: 'POST', url: '/api/voice/sessions', headers: auth });
    expect(create.statusCode).toBe(503);
    expect(create.json()).toEqual({ error: 'Voice channel not available' });
  });

  it('delegates create and end calls to the installed handler', async () => {
    const bridge = new VoiceSessionBridge();
    const createSession = vi.fn().mockResolvedValue({ status: 201, body: { sessionId: 's1' } });
    const endSession = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    bridge.setHandler({
      status: async () => ({ enabled: true }),
      createSession,
      endSession,
    });
    app = await build(bridge);

    const create = await app.inject({
      method: 'POST',
      url: '/api/voice/sessions',
      headers: auth,
      payload: { metadata: { source: 'test' } },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ sessionId: 's1' });
    expect(createSession).toHaveBeenCalledWith({
      principalContactId: '11111111-1111-1111-1111-111111111111',
      metadata: { source: 'test' },
    });

    const end = await app.inject({ method: 'DELETE', url: '/api/voice/sessions/s1', headers: auth });
    expect(end.statusCode).toBe(200);
    expect(endSession).toHaveBeenCalledWith('s1');
  });
});
