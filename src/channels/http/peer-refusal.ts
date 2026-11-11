// peer-refusal.ts — refuse requests from a remote address the server must not serve (#2521).
//
// The browser container shares a network with Curia so Curia can drive it over DevTools,
// which also lets anything running there reach this server. Its pages' own requests go
// through its egress proxy, which refuses Curia's private address; this covers code that
// gets past Chrome. Registered before every other hook, so no route, rate limit or
// authentication check runs for such a request.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../logger.js';

export function registerPeerRefusal(
  app: FastifyInstance,
  refusePeer: (address: string | undefined) => boolean,
  logger: Logger,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!refusePeer(request.socket.remoteAddress)) return;
    logger.warn({ ip: request.socket.remoteAddress, method: request.method }, 'HTTP request from the browser container refused');
    return reply.status(403).send({ error: 'Forbidden' });
  });
}
