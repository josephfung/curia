// handler-grant-revoke.test.ts — delegate revokes the wait's live-turn grant on every exit,
// including a throw while it builds the specialist task (#2515). Separate file: it mocks
// createAgentTask and issueLiveTurnGrant module-wide.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { ToolContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';

const issued = vi.hoisted(() => [] as string[]);
const failTaskCreation = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/autonomy/live-turn-grants.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/autonomy/live-turn-grants.js')>();
  return {
    ...mod,
    issueLiveTurnGrant: (opts: Parameters<typeof mod.issueLiveTurnGrant>[0]) => {
      const grant = mod.issueLiveTurnGrant(opts);
      issued.push(grant.id);
      return grant;
    },
  };
});

vi.mock('../../src/bus/events.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/bus/events.js')>();
  return {
    ...mod,
    createAgentTask: (...args: Parameters<typeof mod.createAgentTask>) => {
      if (failTaskCreation.on) throw new Error('task creation failed');
      return mod.createAgentTask(...args);
    },
  };
});

const { DelegateHandler } = await import('./handler.js');
const { isLiveTurnGrantActive } = await import('../../src/autonomy/live-turn-grants.js');

function makeCtx(): ToolContext {
  const bus = { subscribe() {}, async publish() {} } as unknown as EventBus;
  return {
    input: { agent: 'research-analyst', task: 'find the acquisition comps' },
    log: pino({ level: 'silent' }),
    bus,
    agentRegistry: {
      has: (n: string) => n === 'research-analyst',
      get: (n: string) => ({ name: n, role: 'specialist' }),
      listSpecialists: () => [{ name: 'research-analyst' }],
    },
    agentId: 'coordinator',
    conversationId: 'user-conv',
    channelId: 'email',
    liveTurn: true,
    taskMetadata: { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' } },
  } as unknown as ToolContext;
}

describe('DelegateHandler live-turn grant cleanup (#2515)', () => {
  it('revokes the grant when building the specialist task throws', async () => {
    failTaskCreation.on = true;
    try {
      const result = await new DelegateHandler().execute(makeCtx());
      expect(result.success).toBe(false);
      expect(issued).toHaveLength(1);
      expect(isLiveTurnGrantActive(issued[0])).toBe(false);
    } finally {
      failTaskCreation.on = false;
    }
  });
});
