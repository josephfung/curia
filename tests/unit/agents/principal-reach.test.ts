import { describe, expect, it } from 'vitest';
import { buildBaseSystemPrompt } from '../../../src/agents/system-prompt.js';
import {
  formatPrincipalReachBlock,
  orderFallbackChannels,
} from '../../../src/agents/principal-reach.js';
import { createLogger } from '../../../src/logger.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const logger = createLogger('silent');

describe('principal reach', () => {
  it('omits the block when the agent has no reach channels', async () => {
    const prompt = await buildBaseSystemPrompt(
      { agentId: 'calendar', systemPrompt: 'Body.' },
      { now: NOW, logger },
    );
    expect(prompt.startsWith('Body.')).toBe(true);
    expect(prompt).not.toContain('## Reaching the principal');
  });

  it('names only the channels that agent can use', async () => {
    const prompt = await buildBaseSystemPrompt(
      {
        agentId: 'coordinator',
        systemPrompt: 'Body.',
        principalReach: () => ({ channels: ['signal', 'email'] }),
      },
      { now: NOW, logger },
    );
    expect(prompt.indexOf('## Reaching the principal')).toBeGreaterThan(prompt.indexOf('Body.'));
    expect(prompt).toContain('Signal, then email');
    expect(prompt).not.toContain('phone app');
    expect(prompt).not.toContain('Slack');
  });

  it('keeps the default order and does not quote a standing preference', () => {
    const block = formatPrincipalReachBlock({ channels: ['signal', 'sms', 'email'] });
    expect(block).toContain('standing preferences and an explicit request override this order');
    expect(block).not.toContain('formal tone');
    expect(orderFallbackChannels(['email', 'signal', 'sms'])).toEqual(['signal', 'sms', 'email']);
  });
});
