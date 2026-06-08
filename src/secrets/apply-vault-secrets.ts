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

  // `?? undefined` converts the service's `null` (absent) to the Config field's
  // `undefined`. nylasSelfEmail is typed `string`, so it defaults to '' — matching
  // the previous `process.env.NYLAS_SELF_EMAIL ?? ''` behavior, not an env read.
  config.anthropicApiKey = anthropicApiKey ?? undefined;
  config.openaiApiKey = openaiApiKey ?? undefined;
  config.openrouterApiKey = openrouterApiKey ?? undefined;
  config.apiToken = apiToken ?? undefined;
  config.webAppBootstrapSecret = webAppBootstrapSecret ?? undefined;
  config.nylasApiKey = nylasApiKey ?? undefined;
  config.nylasGrantId = nylasGrantId ?? undefined;
  config.nylasSelfEmail = nylasSelfEmail ?? '';
  config.signalPhoneNumber = signalPhoneNumber ?? undefined;

  // Names only — never values. Lets an operator confirm what the vault supplied
  // vs. what's absent (feature-disabled), which is the whole debuggability win.
  const present = {
    anthropic_api_key: anthropicApiKey !== null,
    openai_api_key: openaiApiKey !== null,
    openrouter_api_key: openrouterApiKey !== null,
    api_token: apiToken !== null,
    web_app_bootstrap_secret: webAppBootstrapSecret !== null,
    nylas_api_key: nylasApiKey !== null,
    nylas_grant_id: nylasGrantId !== null,
    nylas_self_email: nylasSelfEmail !== null,
    signal_phone_number: signalPhoneNumber !== null,
  };
  logger.info({ present }, 'Resolved bootstrap secrets from vault (vault-only, no env fallback)');
}
