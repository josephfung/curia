import { describe, expect, it } from 'vitest';
import { buildBaseSystemPrompt } from '../../../src/agents/system-prompt.js';
import {
  configuredReachChannels,
  formatPrincipalReachBlock,
  orderFallbackChannels,
  reachChannelsFor,
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

describe('configuredReachChannels', () => {
  const allClients = { signal: true, sms: true, slack: true, email: true };
  const identities = (...channels: string[]) => channels.map((channel) => ({ channel }));

  it('needs both a client and a verified identity on the channel', () => {
    expect(configuredReachChannels({
      clients: { signal: true, sms: false, slack: true, email: true },
      principalIdentities: identities('signal', 'sms', 'email'),
      principalPrimaryEmail: null,
    })).toEqual(['signal', 'email']);
  });

  it('counts the primary email as an email identity', () => {
    expect(configuredReachChannels({
      clients: allClients,
      principalIdentities: [],
      principalPrimaryEmail: 'p@example.com',
    })).toEqual(['email']);
  });

  it('adds the phone app only while it is reachable, in the default order', () => {
    const base = {
      clients: allClients,
      principalIdentities: identities('email', 'slack', 'sms', 'signal'),
      principalPrimaryEmail: null,
    };
    expect(configuredReachChannels(base)).toEqual(['signal', 'sms', 'slack', 'email']);
    expect(configuredReachChannels({ ...base, webReachable: false })).toEqual(['signal', 'sms', 'slack', 'email']);
    expect(configuredReachChannels({ ...base, webReachable: true })).toEqual(['signal', 'sms', 'web', 'slack', 'email']);
  });

  it('ignores identities on channels with no send path', () => {
    expect(configuredReachChannels({
      clients: allClients,
      principalIdentities: identities('phone', 'web', 'telegram'),
      principalPrimaryEmail: undefined,
    })).toEqual([]);
  });

  it('is narrowed per agent by its send tools', () => {
    const configured = new Set(configuredReachChannels({
      clients: allClients,
      principalIdentities: identities('signal', 'slack', 'email'),
      principalPrimaryEmail: null,
      webReachable: true,
    }));
    expect(reachChannelsFor(['email-reply', 'web-send'], configured)).toEqual(['web', 'email']);
  });
});
