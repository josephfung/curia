// server-url.ts — which LiveKit address Curia's own end uses (#2357).
//
// Curia's server-side participant, RoomService calls, /api/health and the Setup page's
// probe all reach LiveKit over the management URL (`channels.voice.livekit_management_url`,
// default `http://livekit:7880`, the compose-network name). That name resolves only inside
// the compose network: a Curia run on the host (pnpm dev / pnpm local) cannot resolve it.
// There, the browser-facing URL (the vault's channel.voice.livekit_url, e.g.
// ws://localhost:7880) is reachable from the host too, so it becomes the effective
// management URL, with a warning naming both.

import { lookup as dnsLookup } from 'node:dns/promises';
import type { Logger } from '../../../logger.js';
import { toLiveKitHttpUrl, toLiveKitWsUrl } from './token.js';

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
}): Promise<LiveKitServerUrls> {
  const { managementUrl, browserUrl, logger } = opts;
  const keep = (): LiveKitServerUrls => ({ managementUrl, joinUrl: toLiveKitWsUrl(managementUrl) });
  // Nothing to fall back to: keep the configured URL, and let the Setup probe report it.
  if (!browserUrl) return keep();

  let hostname: string;
  try {
    hostname = new URL(managementUrl).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch (err) {
    logger.warn(
      { err, managementUrl },
      'LiveKit management URL is not a valid URL; check channels.voice.livekit_management_url',
    );
    return keep();
  }

  const lookup = opts.lookup ?? ((h: string) => dnsLookup(h));
  try {
    await lookup(hostname);
    return keep();
  } catch (err) {
    const effective = toLiveKitHttpUrl(browserUrl);
    logger.warn(
      { err, managementUrl, browserUrl, effectiveManagementUrl: effective },
      `LiveKit management host "${hostname}" does not resolve here (Curia is not on the compose network); `
      + 'using the browser-facing LiveKit URL instead. Set channels.voice.livekit_management_url to silence this.',
    );
    return { managementUrl: effective, joinUrl: toLiveKitWsUrl(effective) };
  }
}
