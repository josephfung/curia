// apply-vault-secrets.ts — resolves the bootstrap/config-scoped secrets from the
// vault and writes them onto the Config object (#911). Vault-only: there is NO env
// fallback. loadConfig() no longer reads these from process.env; this is the single
// place they enter Config. Must run after the vault is constructed and migrations
// have run, and before any consumer reads config (anthropic provider, openai
// embeddings, nylas/signal channels). Reads run concurrently; values are never logged.
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { SecretsService } from './secrets-service.js';

export async function applyVaultSecrets(
  config: Config,
  secrets: SecretsService,
  logger: Logger,
): Promise<void> {
  const [
    anthropicApiKey,
    openaiApiKey,
    openrouterApiKey,
    apiToken,
    webAppBootstrapSecret,
    nylasApiKey,
    nylasGrantId,
    nylasSelfEmail,
    signalPhoneNumber,
  ] = await Promise.all([
    secrets.get('anthropic_api_key'),
    secrets.get('openai_api_key'),
    secrets.get('openrouter_api_key'),
    secrets.get('api_token'),
    secrets.get('web_app_bootstrap_secret'),
    secrets.get('nylas_api_key'),
    secrets.get('nylas_grant_id'),
    secrets.get('nylas_self_email'),
    secrets.get('signal_phone_number'),
  ]);

  // Normalize each vault value: trim surrounding whitespace (copy-paste artifacts) and
  // collapse a blank/whitespace-only result to `undefined` (absent). A whitespace-only
  // secret is unusable at runtime — the Anthropic client and HTTP auth reject it, and a
  // blank Signal phone number would otherwise stay truthy and wire up the channel with an
  // invalid account id — so it must read as absent here, keeping the boot guards and the
  // feature-on checks (`if (config.signalPhoneNumber)`) honest rather than letting a
  // truthy-but-empty string slip through. The seeder already trims on write; this is the
  // matching read-side guard for rows set by any other path.
  const clean = (value: string | null): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  config.anthropicApiKey = clean(anthropicApiKey);
  config.openaiApiKey = clean(openaiApiKey);
  config.openrouterApiKey = clean(openrouterApiKey);
  config.apiToken = clean(apiToken);
  config.webAppBootstrapSecret = clean(webAppBootstrapSecret);
  config.nylasApiKey = clean(nylasApiKey);
  config.nylasGrantId = clean(nylasGrantId);
  // nylasSelfEmail is typed `string`, so it defaults to '' — matching the previous
  // `process.env.NYLAS_SELF_EMAIL ?? ''` behavior, not an env read.
  config.nylasSelfEmail = clean(nylasSelfEmail) ?? '';
  config.signalPhoneNumber = clean(signalPhoneNumber);

  // Names only — never values. Lets an operator confirm what the vault supplied
  // vs. what's absent (feature-disabled), which is the whole debuggability win.
  // Uses the same `clean()` as the assignments above so the log reflects what each
  // consumer actually sees — a blank row reads as absent, not present.
  const present = {
    anthropic_api_key: clean(anthropicApiKey) !== undefined,
    openai_api_key: clean(openaiApiKey) !== undefined,
    openrouter_api_key: clean(openrouterApiKey) !== undefined,
    api_token: clean(apiToken) !== undefined,
    web_app_bootstrap_secret: clean(webAppBootstrapSecret) !== undefined,
    nylas_api_key: clean(nylasApiKey) !== undefined,
    nylas_grant_id: clean(nylasGrantId) !== undefined,
    nylas_self_email: clean(nylasSelfEmail) !== undefined,
    signal_phone_number: clean(signalPhoneNumber) !== undefined,
  };
  logger.info({ present }, 'Resolved bootstrap secrets from vault (vault-only, no env fallback)');
}
