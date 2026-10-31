import { describe, expect, it } from 'vitest';
import { buildBaseSystemPrompt } from '../../../src/agents/system-prompt.js';
import {
  formatPrincipalReachBlock,
  orderFallbackChannels,
  urgentPreference,
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
        principalReach: () => ({ channels: ['signal', 'email'], preference: null }),
      },
      { now: NOW, logger },
    );
    expect(prompt.indexOf('## Reaching the principal')).toBeLessThan(prompt.indexOf('Body.'));
    expect(prompt).toContain('Signal, then email');
    expect(prompt).not.toContain('phone app');
    expect(prompt).not.toContain('Slack');
  });

  it('states a standing preference before the default order', () => {
    const preference = 'When something needs the principal right away, use one channel: email.';
    expect(urgentPreference([preference, 'Be concise'])).toBe(preference);
    const block = formatPrincipalReachBlock({
      channels: ['signal', 'sms', 'email'],
      preference,
    });
    expect(block).not.toBeNull();
    expect(block!.indexOf('overrides the default order')).toBeLessThan(block!.indexOf('reach them in this order'));
    expect(block).toContain('use one channel: email');
    expect(orderFallbackChannels(['signal', 'sms', 'slack', 'email'], preference)).toEqual([
      'email',
      'signal',
      'sms',
      'slack',
    ]);
  });
});
