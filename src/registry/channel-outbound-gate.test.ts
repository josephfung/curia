// src/registry/channel-outbound-gate.test.ts
import { describe, it, expect } from 'vitest';
import { gateOutboundClientsForRegistry, hasRegistryGatedOutboundClient } from './channel-outbound-gate.js';
import type { NylasClient } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';

const fakeNylasMap = () => new Map<string, NylasClient>([['curia', {} as NylasClient]]);
const fakeSignal = {} as SignalRpcClient;

describe('gateOutboundClientsForRegistry', () => {
  it('exposes email outbound only when the registry marks email enabled', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['email']),
      fakeNylasMap(),
      fakeSignal,
      '+15551234567',
    );
    expect(gated.nylasClients?.size).toBe(1);
    expect(gated.signalClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(true);
  });

  it('exposes signal outbound only when the registry marks signal enabled', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['signal']),
      fakeNylasMap(),
      fakeSignal,
      '+15551234567',
    );
    expect(gated.nylasClients).toBeUndefined();
    expect(gated.signalClient).toBe(fakeSignal);
    expect(gated.signalPhoneNumber).toBe('+15551234567');
    expect(hasRegistryGatedOutboundClient(gated)).toBe(true);
  });

  it('omits outbound clients for disabled/uninstalled toggleable channels', () => {
    const gated = gateOutboundClientsForRegistry(
      new Set(['http', 'cli']),
      fakeNylasMap(),
      fakeSignal,
      '+15551234567',
    );
    expect(gated.nylasClients).toBeUndefined();
    expect(gated.signalClient).toBeUndefined();
    expect(hasRegistryGatedOutboundClient(gated)).toBe(false);
  });
});
