/**
 * Registry enrollment coverage for dispatcher-relay (#1733 review).
 *
 * The skill must be in config/registry-defaults.yaml so reconcile enrolls an
 * enabled row and loadToolsFromDirectory registers the handler. Without that,
 * approve-action's invoke('dispatcher-relay', …) returns "not found in registry"
 * after marking the approval row approved — destroying the reply.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import pino from 'pino';
import { discoverToolManifests, loadToolsFromDirectory } from '../../../src/skills/loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import type { EventBus } from '../../../src/bus/bus.js';

const logger = pino({ level: 'silent' });

describe('dispatcher-relay registry enrollment (#1733)', () => {
  it('is listed in config/registry-defaults.yaml tools so reconcile can enroll it', () => {
    const defaultsPath = path.resolve(import.meta.dirname, '../../../config/registry-defaults.yaml');
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const loaded = yaml.load(raw) as { tools?: string[] };
    expect(loaded.tools).toContain('dispatcher-relay');
  });

  it('loads into ToolRegistry when enabled and is invokable via ExecutionLayer', async () => {
    const registry = new ToolRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');
    const discoveries = discoverToolManifests(skillsDir);
    expect(discoveries.some((d) => d.name === 'dispatcher-relay')).toBe(true);

    const count = await loadToolsFromDirectory(
      discoveries,
      registry,
      logger,
      new Set(['dispatcher-relay']),
    );
    expect(count).toBe(1);
    expect(registry.get('dispatcher-relay')).toBeDefined();
    expect(registry.get('dispatcher-relay')!.manifest.allowed_callers).toEqual(['system']);

    const published: unknown[] = [];
    const bus = {
      publish: async (_layer: string, event: unknown) => {
        published.push(event);
      },
    } as unknown as EventBus;

    const execution = new ExecutionLayer(registry, logger, { bus });
    const result = await execution.invoke(
      'dispatcher-relay',
      {
        channelId: 'email',
        to: 'dana@example.com',
        body: 'Approved body',
        conversationId: 'email:thread-1',
      },
      { contactId: 'primary-user', role: 'ceo', channel: 'cli' },
      { humanApproved: true, taskEventId: 'task-approve-1', agentId: 'approve-action' },
    );

    expect(result.success).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'outbound.message',
      payload: {
        content: 'Approved body',
        recipientId: 'dana@example.com',
        channelId: 'email',
      },
    });
  });

  it('rejects non-system callers without humanApproved (allowed_callers enforcement)', async () => {
    const registry = new ToolRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');
    const discoveries = discoverToolManifests(skillsDir);
    await loadToolsFromDirectory(
      discoveries,
      registry,
      logger,
      new Set(['dispatcher-relay']),
    );

    const execution = new ExecutionLayer(registry, logger, {
      bus: { publish: async () => undefined } as unknown as EventBus,
    });
    const result = await execution.invoke(
      'dispatcher-relay',
      {
        channelId: 'email',
        to: 'dana@example.com',
        body: 'Should not send',
        conversationId: 'email:thread-1',
      },
      { contactId: 'agent-1', role: null, channel: 'email' },
      { agentId: 'coordinator', taskEventId: 'task-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not allowed to call|allowed_callers|system/i);
  });
});
