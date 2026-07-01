// src/registry/channel-outbound-gate.ts
// Gate outbound client wiring on the same registry decision as inbound adapter start.
import type { NylasClient } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';

export interface RegistryGatedOutboundClients {
  nylasClients: Map<string, NylasClient> | undefined;
  signalClient: SignalRpcClient | undefined;
  signalPhoneNumber: string | undefined;
}

export function gateOutboundClientsForRegistry(
  channelShouldStart: ReadonlySet<string>,
  nylasClientMap: Map<string, NylasClient>,
  signalRpcClient: SignalRpcClient | undefined,
  signalPhoneNumber: string | undefined,
): RegistryGatedOutboundClients {
  const emailEnabled = channelShouldStart.has('email');
  const signalEnabled = channelShouldStart.has('signal');
  return {
    nylasClients: emailEnabled && nylasClientMap.size > 0 ? nylasClientMap : undefined,
    signalClient: signalEnabled ? signalRpcClient : undefined,
    signalPhoneNumber: signalEnabled ? signalPhoneNumber : undefined,
  };
}

export function hasRegistryGatedOutboundClient(clients: RegistryGatedOutboundClients): boolean {
  return (clients.nylasClients?.size ?? 0) > 0 || clients.signalClient !== undefined;
}
