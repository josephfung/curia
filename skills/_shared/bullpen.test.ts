// The execution layer injects only the capabilities a manifest declares (bus included),
// so each bullpen tool's guard must ask for no more than its tool.json declares. The
// handler tests' fixture injects everything, which is how a missing `bus` went unseen.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BullpenService } from '../../src/memory/bullpen.js';
import { createLogger } from '../../src/logger.js';
import type { ToolContext, ToolHandler } from '../../src/skills/types.js';
import { BullpenPostHandler } from '../bullpen/tools/bullpen-post/handler.js';
import { BullpenReplyHandler } from '../bullpen/tools/bullpen-reply/handler.js';
import { BullpenReadHandler } from '../bullpen/tools/bullpen-read/handler.js';
import { BullpenCloseHandler } from '../bullpen/tools/bullpen-close/handler.js';

const TOOLS_DIR = resolve(import.meta.dirname, '../bullpen/tools');

function declaredCapabilities(tool: string): string[] {
  const manifest = JSON.parse(readFileSync(resolve(TOOLS_DIR, tool, 'tool.json'), 'utf-8')) as {
    capabilities?: string[];
  };
  return manifest.capabilities ?? [];
}

describe('bullpen tools run with only their declared capabilities', () => {
  it.each([
    ['bullpen-post', new BullpenPostHandler(), (_t: string) => ({ topic: 'T', participants: ['calendar'], content: 'hi' })],
    ['bullpen-reply', new BullpenReplyHandler(), (t: string) => ({ thread_id: t, content: 'ok' })],
    ['bullpen-read', new BullpenReadHandler(), (t: string) => ({ thread_id: t })],
    ['bullpen-close', new BullpenCloseHandler(), (t: string) => ({ thread_id: t })],
  ] as Array<[string, ToolHandler, (threadId: string) => Record<string, unknown>]>)(
    '%s',
    async (tool, handler, input) => {
      const service = BullpenService.createInMemory();
      const { thread } = await service.openThread('T', 'coordinator', ['coordinator', 'calendar'], 'start', []);
      const services: Record<string, unknown> = {
        bullpenService: service,
        bus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() },
        agentRegistry: { has: () => true, list: () => [] },
      };
      const ctx: Record<string, unknown> = {
        input: input(thread.id),
        log: createLogger('error'),
        agentId: 'coordinator',
        taskEventId: 'task-1',
        secret: () => { throw new Error('no secrets'); },
      };
      for (const cap of declaredCapabilities(tool)) ctx[cap] = services[cap];

      const result = await handler.execute(ctx as unknown as ToolContext);
      expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    },
  );
});
