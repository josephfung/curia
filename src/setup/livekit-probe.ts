// livekit-probe.ts — asks LiveKit whether it answers with the saved keys, for the Setup
// page's Voice task (#2357). Saved keys and a started voice channel say nothing about a
// LiveKit container that never came up.

import type { Logger } from '../logger.js';
import { listVoiceRooms } from '../channels/voice/livekit/token.js';

/**
 * - `unreachable`: LiveKit's host answered but nothing listens (refused), or LiveKit answered
 *   with an error: the container is down.
 * - `misconfigured`: the management URL's host does not resolve, or the request timed out:
 *   Curia is pointed at the wrong address (`channels.voice.livekit_management_url`).
 */
export type LiveKitProbeResult = 'ok' | 'no_keys' | 'unreachable' | 'misconfigured' | 'rejected';

/** Short on purpose: Setup waits on this while it renders. */
const PROBE_TIMEOUT_SEC = 3;

/** DNS failures and timeouts: the address is wrong, not the container down. */
const MISCONFIGURED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

/** fetch() wraps the socket error in TypeError('fetch failed') with the code on `cause`. */
function isMisconfigured(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 3 && typeof cur === 'object' && cur !== null; depth++) {
    const e = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === 'TimeoutError') return true;
    if (typeof e.code === 'string' && MISCONFIGURED_CODES.has(e.code)) return true;
    cur = e.cause;
  }
  return false;
}

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
    // livekit-server-sdk's ServerError carries the HTTP status; a refused connection has none.
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: unknown }).status : undefined;
    if (status === 401 || status === 403) {
      deps.logger.debug({ err, status, managementUrl: deps.managementUrl }, 'setup: LiveKit rejected the saved keys');
      return 'rejected';
    }
    if (status === undefined && isMisconfigured(err)) {
      deps.logger.warn(
        { err, managementUrl: deps.managementUrl },
        'setup: LiveKit management URL does not resolve or timed out; check channels.voice.livekit_management_url',
      );
      return 'misconfigured';
    }
    if (typeof status === 'number') {
      // LiveKit answered, but with an error: not the expected "not running" case, so
      // make it visible. Setup still reports it as unreachable.
      deps.logger.warn({ err, status, managementUrl: deps.managementUrl }, 'setup: LiveKit probe got an error response');
    } else {
      deps.logger.debug({ err, managementUrl: deps.managementUrl }, 'setup: LiveKit probe failed');
    }
    return 'unreachable';
  }
}
