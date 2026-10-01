// Test-mode no-send guarantees (#1966). These pieces need no database, so they are
// checked here; tests/integration/test-mode-stack.test.ts checks the assembled stack.
//
// Two ways a message could leave a test run, both closed by construction:
//   1. Through the OutboundGateway — it is built with no transport client and no
//      outbound queue, so every send and draft fails inside the gateway.
//   2. Around it — a skill that calls a provider itself with a declared secret
//      (ceo-inbox → Nylas). The test-mode vault withholds those secrets, which also
//      blocks ExecutionLayer's process.env fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolContext, ToolManifest } from '../../../src/skills/types.js';
import {
  createNoSendOutboundGateway,
  createTestModeSecrets,
  TEST_MODE_PASSTHROUGH_SECRETS,
} from '../../../src/startup/test-mode-stack.js';

const logger = createLogger('error');

function manifest(name: string, secrets: string[]): ToolManifest {
  return {
    name,
    description: name,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets,
    timeout: 5000,
    inputs: {},
    outputs: {},
  };
}

function gateway() {
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  return createNoSendOutboundGateway({
    contactService,
    bus: new EventBus(logger),
    logger,
    principalIdentities: [],
  });
}

describe('createNoSendOutboundGateway', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Any network call from the gateway would go through fetch (Nylas SDK, Slack,
    // Telnyx). Make it loud if one happens.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('has no email account to send from', () => {
    expect(gateway().listAccountIds()).toEqual([]);
  });

  it('fails an email send without touching the network', async () => {
    const result = await gateway().send(
      { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails a Signal send without touching the network', async () => {
    const result = await gateway().send(
      { channel: 'signal', recipient: '+15555550123', message: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails an email draft without touching the network', async () => {
    const result = await gateway().createEmailDraft(
      { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createTestModeSecrets', () => {
  it('withholds account credentials', async () => {
    const vault = createTestModeSecrets();
    await expect(vault.get('nylas_api_key')).rejects.toThrow(/withheld in test mode/);
    await expect(vault.get('ceo_nylas_grant_id')).rejects.toThrow(/withheld in test mode/);
    await expect(vault.get('channel.signal.phone_number')).rejects.toThrow(/withheld in test mode/);
  });

  it('lets read-only lookups fall back to env', async () => {
    const vault = createTestModeSecrets();
    for (const name of TEST_MODE_PASSTHROUGH_SECRETS) {
      await expect(vault.get(name)).resolves.toBeNull();
    }
  });
});

describe('ExecutionLayer with the test-mode vault', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['NYLAS_API_KEY', 'TAVILY_API_KEY']) saved[key] = process.env[key];
    // Production .env values present — the case smoke runs in.
    process.env.NYLAS_API_KEY = 'nylas-key-from-env';
    process.env.TAVILY_API_KEY = 'tavily-key-from-env';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps an env credential away from a skill that would call a provider directly', async () => {
    const registry = new ToolRegistry();
    const seen: string[] = [];
    registry.register(manifest('mailbox-write', ['nylas_api_key']), {
      execute: async (ctx: ToolContext) => {
        seen.push(ctx.secret('nylas_api_key'));
        return { success: true, data: 'wrote to the mailbox' };
      },
    });
    const layer = new ExecutionLayer(registry, logger, { secretsService: createTestModeSecrets() });

    const result = await layer.invoke('mailbox-write', {});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/withheld in test mode/);
    expect(seen).toEqual([]);
  });

  it('still resolves a pass-through secret from env', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('lookup', ['tavily_api_key']), {
      execute: async (ctx: ToolContext) => ({ success: true, data: ctx.secret('tavily_api_key') }),
    });
    const layer = new ExecutionLayer(registry, logger, { secretsService: createTestModeSecrets() });

    const result = await layer.invoke('lookup', {});
    expect(result).toMatchObject({ success: true, data: 'tavily-key-from-env' });
  });
});

describe('ExecutionLayerWrapper (#1956 stub hook)', () => {
  it('a Proxy can answer stubbed tools and delegate everything else', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('real-tool', []), {
      execute: async () => ({ success: true, data: 'real' }),
    });
    const base = new ExecutionLayer(registry, logger);

    // The shape the scenario runner will use: intercept invoke, pass the rest through.
    const wrapped = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'invoke') {
          return async (...args: Parameters<ExecutionLayer['invoke']>) =>
            args[0] === 'stubbed-tool'
              ? { success: true as const, data: 'stubbed' }
              : target.invoke(...args);
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    expect(await wrapped.invoke('stubbed-tool', {})).toEqual({ success: true, data: 'stubbed' });
    expect(await wrapped.invoke('real-tool', {})).toMatchObject({ success: true, data: 'real' });
    expect(wrapped.getToolDefinitions(['real-tool']).map(t => t.name)).toEqual(['real-tool']);
  });
});
