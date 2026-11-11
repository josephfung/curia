// Tests for the HTTP server's refusal of the browser container (#2521).

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { registerPeerRefusal } from '../../../../src/channels/http/peer-refusal.js';

const logger = pino({ level: 'silent' });
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(refusePeer: (address: string | undefined) => boolean): Promise<string> {
  app = Fastify();
  registerPeerRefusal(app, refusePeer, logger);
  let written = false;
  app.post('/api/pairing/redeem', async () => { written = true; return { ok: written }; });
  app.get('/', async () => 'console');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('registerPeerRefusal', () => {
  it('refuses every route, before the handler runs, for a refused address', async () => {
    const seen: Array<string | undefined> = [];
    const base = await serve((address) => { seen.push(address); return true; });

    const post = await fetch(`${base}/api/pairing/redeem`, { method: 'POST' });
    const get = await fetch(`${base}/`);

    expect(post.status).toBe(403);
    expect(get.status).toBe(403);
    expect(seen[0]).toMatch(/127\.0\.0\.1$/);
  });

  it('serves any other address as before', async () => {
    const base = await serve(() => false);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console');
  });
});
