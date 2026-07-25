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

/**
 * Best-effort room teardown after a session ends so a leaked JWT cannot rejoin
 * an empty room. Failures are logged by the caller — never throw into hangup.
 */
export async function deleteVoiceRoom(
  config: LiveKitTokenConfig & { livekitUrl: string },
  roomName: string,
): Promise<void> {
  // RoomServiceClient expects an HTTP(S) host, not the WebSocket URL the
  // browser uses. Map ws(s) → http(s).
  const httpUrl = config.livekitUrl
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');
  const client = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
  await client.deleteRoom(roomName);
}
