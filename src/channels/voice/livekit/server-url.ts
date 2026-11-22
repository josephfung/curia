// server-url.ts — which LiveKit address Curia's own end uses (#2357).
//
// Curia's server-side participant, RoomService calls, /api/health and the Setup page's
// probe all reach LiveKit over the management URL (`channels.voice.livekit_management_url`,
// default `http://livekit:7880`, the compose-network name). That name resolves only inside
// the compose network: a Curia run on the host (pnpm dev / pnpm local) cannot resolve it.
// There, the browser-facing URL (the vault's channel.voice.livekit_url, e.g.
// ws://localhost:7880) is reachable from the host too, so it becomes the effective
// management URL, with a warning naming both.
//
// Only for the compose name itself (host `livekit`, as in the default): a management URL
// pointing anywhere else was set on purpose, so it is kept even when its lookup fails or is
// slow at boot. Swapping it for the browser URL would last until the next restart, long
// after a passing DNS failure, and a public proxy may route only /rtc*, not /twirp.
//
// Never inside a container: there the compose name is right even when it doesn't resolve
// yet (Compose doesn't order curia after livekit, so livekit may be stopped or restarting
// at boot), and the browser URL would be wrong for good (ws://localhost:7880 is the curia
// container itself; https://<domain> is only routed for /rtc*). Keeping the configured URL
// lets Curia recover by itself once livekit is up.

import { existsSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Logger } from '../../../logger.js';
import { toLiveKitHttpUrl, toLiveKitWsUrl } from './token.js';

/** Boot waits on this lookup, so bound it. */
const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;

/** The compose service name in the default management URL (`http://livekit:7880`). */
const COMPOSE_LIVEKIT_HOST = 'livekit';

export interface LiveKitServerUrls {
  /** http(s) base for RoomService, health and the Setup probe. */
  managementUrl: string;
  /** ws(s) signaling URL Curia's own participant joins rooms with. */
  joinUrl: string;
}

export async function resolveLiveKitServerUrl(opts: {
  managementUrl: string;
  /** Browser-facing signaling URL; undefined when voice has none saved. */
  browserUrl: string | undefined;
  logger: Logger;
  /** Injectable for tests; rejects when the host does not resolve. */
  lookup?: (hostname: string) => Promise<unknown>;
  /** True when Curia runs in a container (Docker writes /.dockerenv). Injectable for tests. */
  inContainer?: () => boolean;
  lookupTimeoutMs?: number;
}): Promise<LiveKitServerUrls> {
  const { managementUrl, browserUrl, logger } = opts;
  const keep = (): LiveKitServerUrls => ({ managementUrl, joinUrl: toLiveKitWsUrl(managementUrl) });
  // Nothing to fall back to: keep the configured URL, and let the Setup probe report it.
  if (!browserUrl) return keep();
  const inContainer = opts.inContainer ?? (() => existsSync('/.dockerenv'));
  if (inContainer()) return keep();

  let hostname: string;
  try {
    hostname = new URL(managementUrl).hostname;
  } catch (err) {
    logger.warn(
      { err, managementUrl },
      'LiveKit management URL is not a valid URL; check channels.voice.livekit_management_url',
    );
    return keep();
  }
  // An explicit address is kept as configured: no lookup, no substitution.
  if (hostname !== COMPOSE_LIVEKIT_HOST) return keep();

  const lookup = opts.lookup ?? ((h: string) => dnsLookup(h));
  const timeoutMs = opts.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`DNS lookup of ${hostname} timed out after ${timeoutMs} ms`), { code: 'ETIMEOUT' })),
          timeoutMs,
        );
      }),
    ]);
    return keep();
  } catch (err) {
    const effective = toLiveKitHttpUrl(browserUrl);
    logger.warn(
      { err, managementUrl, browserUrl, effectiveManagementUrl: effective },
      `LiveKit management host "${hostname}" does not resolve here (Curia runs outside the compose network); `
      + 'using the browser-facing LiveKit URL instead. Set channels.voice.livekit_management_url to silence this.',
    );
    return { managementUrl: effective, joinUrl: toLiveKitWsUrl(effective) };
  } finally {
    clearTimeout(timer);
  }
}
