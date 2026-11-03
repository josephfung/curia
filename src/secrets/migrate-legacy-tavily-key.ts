// migrate-legacy-tavily-key.ts — one-way copy of a legacy Tavily key (#2409 item 2, #2445).
//
// Before #2445 the setup wizard's secure link stored the Tavily key as
// `user.tavily_api_key`, but web-search reads `tavily_api_key`, so the key never
// took effect. This copies the legacy value across at boot when the canonical key
// is absent. The `user.*` entry is left in place: it lives in the principal's own
// credential store, and deleting it is not ours to decide. Idempotent — once the
// canonical key exists, this does nothing.
import type { Logger } from '../logger.js';
import type { SecretsService } from './secrets-service.js';

export const LEGACY_TAVILY_KEY = 'user.tavily_api_key';
export const TAVILY_KEY = 'tavily_api_key';

/** Returns true when it copied the legacy key. Vault errors propagate to the caller. */
export async function migrateLegacyTavilyKey(secrets: SecretsService, logger: Logger): Promise<boolean> {
  if (await secrets.get(TAVILY_KEY) !== null) return false;
  const legacy = await secrets.get(LEGACY_TAVILY_KEY);
  if (legacy === null) return false;
  await secrets.set(TAVILY_KEY, legacy);
  // Names only — the value is never logged.
  logger.info({ from: LEGACY_TAVILY_KEY, to: TAVILY_KEY }, 'Copied legacy Tavily key to the key web-search reads');
  return true;
}
