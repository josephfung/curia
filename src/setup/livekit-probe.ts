// livekit-probe.ts — asks LiveKit whether it answers with the saved keys, for the Setup
// page's Voice task (#2357). Saved keys and a started voice channel say nothing about a
// LiveKit container that never came up.

import type { Logger } from '../logger.js';
import { listVoiceRooms } from '../channels/voice/livekit/token.js';

export type LiveKitProbeResult = 'ok' | 'no_keys' | 'unreachable' | 'rejected';

/** Short on purpose: Setup waits on this while it renders. */
const PROBE_TIMEOUT_SEC = 3;

export async function probeLiveKit(deps: {
  getSecret: (name: string) => Promise<string | null>;
  managementUrl: string;
  logger: Logger;
  listRooms?: typeof listVoiceRooms;
}): Promise<LiveKitProbeResult> {
  const apiKey = await deps.getSecret('channel.voice.livekit_api_key');
  const apiSecret = await deps.getSecret('channel.voice.livekit_api_secret');
  if (!apiKey || !apiSecret) return 'no_keys';
  const listRooms = deps.listRooms ?? listVoiceRooms;
  try {
    await listRooms({ apiKey, apiSecret, livekitManagementUrl: deps.managementUrl }, PROBE_TIMEOUT_SEC);
    return 'ok';
  } catch (err) {
    deps.logger.debug({ err, managementUrl: deps.managementUrl }, 'setup: LiveKit probe failed');
    // livekit-server-sdk's ServerError carries the HTTP status; a refused connection has none.
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: unknown }).status : undefined;
    return status === 401 || status === 403 ? 'rejected' : 'unreachable';
  }
}
