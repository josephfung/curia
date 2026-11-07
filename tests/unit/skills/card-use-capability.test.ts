// card-use-capability.test.ts — how the execution layer fences the card-use tools (#1358).
// The real manifests and handlers run; only the CardUseService is a stub.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import type { CardUseCapability } from '../../../src/secrets/card-use-service.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import { CardUseConfirmHandler, CARD_USE_CONFIRM_REFUSAL } from '../../../skills/web/tools/card-use-confirm/handler.js';
import { CardUseRequestHandler } from '../../../skills/web/tools/card-use-request/handler.js';

const logger = pino({ level: 'silent' });

function manifestOf(tool: string): ToolManifest {
  const path = resolve(import.meta.dirname, `../../../skills/web/tools/${tool}/tool.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as ToolManifest;
}

function setup() {
  const cardUse = {
    request: vi.fn(),
    confirm: vi.fn().mockResolvedValue({ outcome: 'approved', resumed: true, message: 'ok' }),
    decline: vi.fn(),
  };
  const registry = new ToolRegistry();
  registry.register(manifestOf('card-use-confirm'), new CardUseConfirmHandler());
  registry.register(manifestOf('card-use-request'), new CardUseRequestHandler());
  const layer = new ExecutionLayer(registry, logger, { cardUseService: cardUse as unknown as CardUseCapability });
  return { cardUse, registry, layer };
}

describe('card-use-confirm manifest', () => {
  it('is critical, system-only, and not a coordinator tool', () => {
    const m = manifestOf('card-use-confirm');
    expect(m.action_risk).toBe('critical');
    expect(m.allowed_callers).toEqual(['system']);
  });
});

describe('card-use-confirm fencing', () => {
  it('cannot be invoked by an agent, even with the coordinator as caller', async () => {
    const { layer, cardUse } = setup();
    const result = await layer.invoke('card-use-confirm', { request_id: 'req-1' }, undefined, { agentId: 'coordinator' });
    expect(result.success).toBe(false);
    expect(cardUse.confirm).not.toHaveBeenCalled();
  });

  it('refuses a system call that is not an approval replay', async () => {
    const { layer, cardUse } = setup();
    const result = await layer.invoke('card-use-confirm', { request_id: 'req-1' });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain(CARD_USE_CONFIRM_REFUSAL);
    expect(cardUse.confirm).not.toHaveBeenCalled();
  });

  it('runs as an approval replay and passes how it was approved and from which conversation', async () => {
    const { layer, cardUse } = setup();
    const result = await layer.invoke('card-use-confirm', { request_id: 'req-1' }, undefined, {
      humanApproved: true,
      approvalVia: 'reaction',
      conversationId: 'conv-1',
    });
    expect(result.success).toBe(true);
    expect(cardUse.confirm).toHaveBeenCalledWith('req-1', 'reaction', 'conv-1');
  });

  it('ignores approvalVia on a call that is not human-approved', async () => {
    const { layer, cardUse } = setup();
    await layer.invoke('card-use-confirm', { request_id: 'req-1' }, undefined, { approvalVia: 'coordinator' });
    expect(cardUse.confirm).not.toHaveBeenCalled();
  });
});

describe('cardUse capability allowlist', () => {
  it('refuses a skill that declares cardUse but is not on the allowlist', async () => {
    const { registry, layer } = setup();
    const handler = { execute: vi.fn().mockResolvedValue({ success: true, data: {} }) };
    registry.register({ ...manifestOf('card-use-request'), name: 'sneaky', allowed_callers: undefined }, handler);
    const result = await layer.invoke('sneaky', {});
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('card-use allowlist');
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('keeps card-use-request to the coordinator', async () => {
    const { layer } = setup();
    const result = await layer.invoke('card-use-request', {}, undefined, { agentId: 'research-analyst' });
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('restricted to agents: coordinator');
  });
});
