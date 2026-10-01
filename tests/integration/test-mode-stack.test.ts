// The test-mode stack against a real database (#1966). Two promises to keep:
//   1. Its coordinator gets the production system prompt — every block AgentRuntime
//      adds, built from the real agents/ and skills/ directories.
//   2. Nothing it does can send a message.
//
// Not destructive: the stack writes only the idempotent bootstrap rows a real boot
// writes (office identity, agent contact). Skips without DATABASE_URL.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomyService } from '../../src/autonomy/autonomy-service.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../src/agents/prompts/date-resolve-guardrail.js';
import { compileSecurityContextBlock, resolveSecurityThresholds } from '../../src/security/security-context.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('test-mode stack', () => {
  let stack: TestModeStack;
  let rendered: string;

  beforeAll(async () => {
    // Offline providers: rendering and invoking tools need no API key. 'all' so the
    // result does not depend on whatever another suite left in the registry tables.
    stack = await createTestModeStack({ llm: 'offline', enablement: 'all' });
    rendered = await stack.renderSystemPrompt('coordinator');
  }, 120_000);

  afterAll(async () => {
    await stack?.shutdown();
  });

  describe('coordinator system prompt', () => {
    it('opens with the identity block, then the security block, then the YAML body', () => {
      const identity = stack.officeIdentityService.compileSystemPromptBlock();
      const thresholds = resolveSecurityThresholds(stack.yamlConfig.security?.trust_thresholds);
      if (!thresholds.ok) throw new Error('config/default.yaml trust_thresholds should be valid');
      const security = compileSecurityContextBlock(thresholds.thresholds);

      expect(rendered.startsWith(identity + '\n\n' + security + '\n\n')).toBe(true);
    });

    it('carries every pinned SKILL.md body', () => {
      const blocks = stack.agent('coordinator').pinResolution.instructionBlocks;
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(rendered).toContain(block);
    });

    it('carries the roster, autonomy, date guardrail, own contact details and turn budget', async () => {
      expect(rendered).toContain('## Available Specialists\n' + stack.agentRegistry.specialistSummary());

      const autonomy = await stack.autonomyService.getConfig();
      expect(autonomy).not.toBeNull();
      expect(rendered).toContain(AutonomyService.formatPromptBlock(autonomy!));

      expect(rendered).toContain(DATE_RESOLVE_GUARDRAIL);
      expect(rendered).toContain('## Current Date & Time');
      expect(rendered).toContain(`- Contact ID: ${stack.agentContactId}`);
      expect(rendered).toContain('## Turn budget');
    });

    it('carries the principal contact details when a principal exists', () => {
      // Other suites create and delete the principal in this shared DB, so the
      // block's presence follows whatever the stack saw at boot.
      if (stack.principalContactId) {
        expect(rendered).toContain('## Principal Contact Details');
      } else {
        expect(rendered).not.toContain('## Principal Contact Details');
      }
    });
  });

  describe('no outbound message can leave the process', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
      // The production-.env case: provider credentials present in the environment.
      for (const key of ['NYLAS_API_KEY', 'CEO_NYLAS_GRANT_ID']) {
        savedEnv[key] = process.env[key];
        process.env[key] = `${key.toLowerCase()}-from-env`;
      }
    });
    afterEach(() => {
      fetchSpy.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('has a gateway with no account to send from', () => {
      expect(stack.outboundGateway.listAccountIds()).toEqual([]);
    });

    it('fails a principal-approved email send inside the gateway', async () => {
      const result = await stack.outboundGateway.send(
        { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
        { humanApproved: true },
      );
      expect(result.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // Whichever layer refuses first — today the missing outboundContext capability,
    // otherwise the transport-less gateway above — the result must be a failure with
    // no network call. Asserting on the outcome keeps this true if the wiring changes.
    it('fails email-send and signal-send invoked the way the coordinator would', async () => {
      const opts = { agentId: 'coordinator', channelId: 'cli', conversationId: 'test-mode-no-send' };
      const email = await stack.executionLayer.invoke(
        'email-send',
        { to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
        undefined,
        opts,
      );
      const signal = await stack.executionLayer.invoke(
        'signal-send',
        { recipient: '+15555550123', message: 'Hello' },
        undefined,
        opts,
      );
      expect(email.success).toBe(false);
      expect(signal.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('withholds env credentials from a skill that calls Nylas directly', async () => {
      // ceo-inbox drafts go straight to the principal's mailbox with its own Nylas
      // credentials, never through the gateway.
      const result = await stack.executionLayer.invoke(
        'ceo-inbox-draft-compose',
        { to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
        undefined,
        { agentId: 'ceo-inbox', channelId: 'cli', conversationId: 'test-mode-no-send' },
      );
      expect(result.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
