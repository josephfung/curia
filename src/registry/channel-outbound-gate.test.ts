import { describe, it, expect } from 'vitest';
import { gateOutboundClientsForRegistry, hasRegistryGatedOutboundClient } from './channel-outbound-gate.js';
import type { NylasClient } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { SlackClient } from '../channels/slack/slack-client.js';

const fakeNylas = {} as NylasClient;
const fakeSignal = {} as SignalRpcClient;
const fakeSlack = {} as SlackClient;

describe('gateOutboundClientsForRegistry', () => {
  it('passes through email clients when email is in channelShouldStart', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['email', 'http', 'cli']),
      new Map([['curia', fakeNylas]]),
      fakeSignal,
      '+15551212',
      fakeSlack,
    );
    expect(gated.nylasClients?.size).toBe(1);
    expect(gated.signalClient).toBeUndefined();
    expect(gated.slackClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(true);
  });

  it('passes through signal client when signal is in channelShouldStart', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['signal', 'http', 'cli']),
      new Map(),
      fakeSignal,
      '+15551212',
      fakeSlack,
    );
    expect(gated.signalClient).toBe(fakeSignal);
    expect(gated.signalPhoneNumber).toBe('+15551212');
    expect(gated.slackClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(true);
  });

  it('passes through slack client when slack is in channelShouldStart', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['slack', 'http', 'cli']),
      new Map(),
      undefined,
      undefined,
      fakeSlack,
    );
    expect(gated.slackClient).toBe(fakeSlack);
    expect(gated.signalClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(true);
  });

  it('returns no clients when toggleable channels are disabled', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['http', 'cli']),
      new Map([['curia', fakeNylas]]),
      fakeSignal,
      '+15551212',
      fakeSlack,
    );
    expect(gated.nylasClients).toBeUndefined();
    expect(gated.signalClient).toBeUndefined();
    expect(gated.slackClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(false);
  });
});
