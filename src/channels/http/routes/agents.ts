// agents.ts — GET /api/agents/status endpoint.
//
// Returns a snapshot of all registered agents and their metadata.
// In Phase 5 this is a static list from the registry; future phases
// will add real-time agent state (idle/thinking/using_tool/etc.).

import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../../../agents/agent-registry.js';

export interface AgentRouteOptions {
  agentRegistry: AgentRegistry;
}

export async function agentRoutes(
  app: FastifyInstance,
  options: AgentRouteOptions,
): Promise<void> {
  const { agentRegistry } = options;

  app.get('/api/agents/status', async (_request, reply) => {
    const agents = agentRegistry.list().map(a => ({
      name: a.name,
      role: a.role,
      description: a.description,
      // TODO: Add real-time state (idle/thinking/using_tool) in Phase 6
      state: 'idle',
    }));

    return reply.send({ agents });
  });
}
