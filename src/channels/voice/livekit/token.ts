import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export interface LiveKitTokenConfig {
  apiKey: string;
  apiSecret: string;
}

export interface MintVoiceTokenInput {
  roomName: string;
  identity: string;
  name?: string;
  /**
   * JWT lifetime. Defaults to 1h (well under the SDK's 6h default) so a leaked
   * browser token cannot rejoin a voice room for half a day.
   */
  ttl?: string;
}

/** Default participant JWT TTL — long enough for a call, short enough if leaked. */
export const DEFAULT_VOICE_TOKEN_TTL = '1h';

export async function mintVoiceParticipantToken(
  config: LiveKitTokenConfig,
  input: MintVoiceTokenInput,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: input.ttl ?? DEFAULT_VOICE_TOKEN_TTL,
  });
  token.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}

/** Map a LiveKit URL to the HTTP(S) host RoomServiceClient expects. */
export function toLiveKitHttpUrl(livekitManagementUrl: string): string {
  return livekitManagementUrl
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');
}

/**
 * Lightweight LiveKit management reachability probe for /api/health (#1567).
 *
 * `livekitManagementUrl` must be the server→LiveKit HTTP(S) base (e.g.
 * `http://livekit:7880` on the compose network), **not** the browser signaling
 * URL (`wss://…`) — same constraint as deleteVoiceRoom (#1555 / ADR-037).
 */
export async function listVoiceRooms(
  config: LiveKitTokenConfig & { livekitManagementUrl: string },
): Promise<unknown[]> {
  // Bound the SDK request itself — Promise.race in checkVoice only stops waiting;
  // without requestTimeout a dead LiveKit host keeps sockets open (#1567 review).
  const client = new RoomServiceClient(
    toLiveKitHttpUrl(config.livekitManagementUrl),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: 5 },
  );
  return client.listRooms();
}

/**
 * Best-effort room teardown after a session ends so a leaked JWT cannot rejoin
 * an empty room. Failures are logged by the caller — never throw into hangup.
 *
 * `livekitManagementUrl` must be the server→LiveKit HTTP(S) base (e.g.
 * `http://livekit:7880` on the compose network), **not** the browser signaling
 * URL (`wss://…`). Caddy often routes only `/rtc*` to LiveKit; `/twirp` RoomService
 * calls against the public domain 404 on the Curia app (#1555).
 */
export async function deleteVoiceRoom(
  config: LiveKitTokenConfig & { livekitManagementUrl: string },
  roomName: string,
): Promise<void> {
  const client = new RoomServiceClient(
    toLiveKitHttpUrl(config.livekitManagementUrl),
    config.apiKey,
    config.apiSecret,
  );
  await client.deleteRoom(roomName);
}
