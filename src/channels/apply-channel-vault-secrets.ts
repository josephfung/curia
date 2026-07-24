// apply-channel-vault-secrets.ts — overlays the channel-scoped vault credentials
// (channel.email.* / channel.signal.* / channel.slack.*, written by the Channels UI)
// onto Config, so adapters actually boot from creds configured entirely through the
// console (#964). Closes the seam where the registry gate read channel.* but the
// adapters read config (populated only from the unprefixed bootstrap keys / env).
//
// Runs right after applyVaultSecrets() and before any config consumer (resolveChannelAccounts,
// nylasClientMap, outbound gateway). Precedence per field mirrors the registry resolver
// (channelCredentialStatus): channel.<name>.<key> (vault) ▸ env (catalog envFallback) ▸
// the current config value (which already carries the bootstrap-vault result). Because the
// precedence matches the gate, "enabled + resolvable" and actual adapter boot agree.
//
// NAMESPACE SAFETY (do not relax): this reads a FIXED allowlist of channel.* keys.
// It must never call secrets.list() or scan by prefix — that keeps user.* (agent-captured)
// secrets and dot-free skill/system secrets structurally out of reach.
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
// Shared so the gate (channelCredentialStatus) and this overlay make the SAME present/absent
// decision — in particular both treat a whitespace-only value as absent (#964).
import { normalizeSecretValue } from './credential-resolver.js';

/** Narrow view of the vault — only get() is needed (and only get() must ever be called). */
interface ChannelSecretsPort {
  get(name: string): Promise<string | null>;
}

/** Read one vault key, isolated: a transient failure logs and reads as absent, never aborts boot. */
async function readVaultKey(
  secrets: ChannelSecretsPort,
  key: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    return normalizeSecretValue(await secrets.get(key));
  } catch (err) {
    logger.warn({ err, key }, 'channel credential vault read failed; treating as missing and falling back to env/config');
    return undefined;
  }
}

export async function applyChannelVaultSecrets(
  config: Config,
  secrets: ChannelSecretsPort,
  env: Record<string, string | undefined>,
  logger: Logger,
): Promise<void> {
  // Resolve channel-vault ▸ env ▸ current-config for one field. Reads are concurrent.
  const resolve = async (
    vaultKey: string,
    envVar: string,
    current: string | undefined,
  ): Promise<string | undefined> =>
    (await readVaultKey(secrets, vaultKey, logger)) ?? normalizeSecretValue(env[envVar]) ?? normalizeSecretValue(current);

  const [
    nylasApiKey,
    nylasGrantId,
    nylasSelfEmail,
    signalPhoneNumber,
    signalSocketPath,
    slackBotToken,
    slackAppToken,
    smsApiKey,
    smsFromNumber,
    smsWebhookPublicKey,
  ] = await Promise.all([
    resolve('channel.email.nylas_api_key', 'NYLAS_API_KEY', config.nylasApiKey),
    resolve('channel.email.nylas_grant_id', 'NYLAS_GRANT_ID', config.nylasGrantId),
    resolve('channel.email.nylas_self_email', 'NYLAS_SELF_EMAIL', config.nylasSelfEmail),
    resolve('channel.signal.phone_number', 'SIGNAL_PHONE_NUMBER', config.signalPhoneNumber),
    resolve('channel.signal.socket_path', 'SIGNAL_SOCKET_PATH', config.signalSocketPath),
    resolve('channel.slack.bot_token', 'SLACK_BOT_TOKEN', config.slackBotToken),
    resolve('channel.slack.app_token', 'SLACK_APP_TOKEN', config.slackAppToken),
    // SMS is vault-only — no env fallback (unlike the legacy channels above). Telnyx
    // credentials must come from the encrypted vault. Keeps the gate resolver
    // (which reads catalog envFallback, absent for sms) in agreement with this overlay.
    readVaultKey(secrets, 'channel.sms.api_key', logger),
    readVaultKey(secrets, 'channel.sms.from_number', logger),
    readVaultKey(secrets, 'channel.sms.webhook_public_key', logger),
  ]);

  config.nylasApiKey = nylasApiKey;
  config.nylasGrantId = nylasGrantId;
  // nylasSelfEmail is typed `string` (defaults to ''), matching loadConfig/applyVaultSecrets.
  config.nylasSelfEmail = nylasSelfEmail ?? '';
  config.signalPhoneNumber = signalPhoneNumber;
  config.signalSocketPath = signalSocketPath;
  config.slackBotToken = slackBotToken;
  config.slackAppToken = slackAppToken;
  config.smsApiKey = smsApiKey;
  config.smsFromNumber = smsFromNumber;
  config.smsWebhookPublicKey = smsWebhookPublicKey;

  // Names only — never values. Lets an operator confirm which channel creds the vault/env
  // supplied vs. which are absent (feature-off), the same debuggability win as applyVaultSecrets.
  const present = {
    'channel.email.nylas_api_key': nylasApiKey !== undefined,
    'channel.email.nylas_grant_id': nylasGrantId !== undefined,
    'channel.email.nylas_self_email': nylasSelfEmail !== undefined,
    'channel.signal.phone_number': signalPhoneNumber !== undefined,
    'channel.signal.socket_path': signalSocketPath !== undefined,
    'channel.slack.bot_token': slackBotToken !== undefined,
    'channel.slack.app_token': slackAppToken !== undefined,
    'channel.sms.api_key': smsApiKey !== undefined,
    'channel.sms.from_number': smsFromNumber !== undefined,
    'channel.sms.webhook_public_key': smsWebhookPublicKey !== undefined,
  };
  logger.info({ present }, 'Applied channel credentials onto config (vault ▸ env ▸ config)');
}
