import { AccessToken } from 'livekit-server-sdk';

export interface LiveKitTokenConfig {
  apiKey: string;
  apiSecret: string;
}

export interface MintVoiceTokenInput {
  roomName: string;
  identity: string;
  name?: string;
}

export async function mintVoiceParticipantToken(
  config: LiveKitTokenConfig,
  input: MintVoiceTokenInput,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.identity,
    name: input.name,
  });
  token.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return token.toJwt();
}
