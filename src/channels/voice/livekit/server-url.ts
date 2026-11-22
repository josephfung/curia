// server-url.ts — the signaling URL Curia's own end of a call joins LiveKit with (#2357).
//
// By default it is the management URL's ws form (`http://livekit:7880` → `ws://livekit:7880`),
// the compose-network address: the browser-facing URL is browser-only, since inside a
// container `ws://localhost:7880` is the container itself. A Curia run on the host
// (`pnpm dev`), where the compose name does not resolve, sets LIVEKIT_INTERNAL_URL
// (e.g. `ws://localhost:7880`) instead.

import { toLiveKitWsUrl } from './token.js';

export function liveKitJoinUrl(managementUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LIVEKIT_INTERNAL_URL?.trim();
  return toLiveKitWsUrl(override || managementUrl);
}
