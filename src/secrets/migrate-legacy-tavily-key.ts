// migrate-legacy-tavily-key.ts — move a Tavily key stored as `user.tavily_api_key` to the
// `tavily_api_key` vault key that web-search reads (#2409).
//
// The setup checklist once named `user.tavily_api_key` as the Tavily key. web-search (and the
// registry's install.requires_secrets gate) only ever read `tavily_api_key`, so a key saved
// under the user name left search off while the checklist marked it done.
//
// Deliberately narrow: one fixed source name, one fixed target name. It never scans the
// user.* namespace, and it never overwrites a `tavily_api_key` that is already set. Runs at
// boot, before registry reconciliation, so web-search enrolls on the same boot.

import type { Logger } from '../logger.js';

export const LEGACY_TAVILY_KEY = 'user.tavily_api_key';
export const TAVILY_KEY = 'tavily_api_key';

interface TavilyMigrationSecretsPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type TavilyMigrationOutcome = 'moved' | 'kept_existing' | 'nothing_to_move';

export async function migrateLegacyTavilyKey(
  secrets: TavilyMigrationSecretsPort,
  logger: Logger,
): Promise<TavilyMigrationOutcome> {
  const legacy = (await secrets.get(LEGACY_TAVILY_KEY))?.trim();
  if (!legacy) return 'nothing_to_move';

  const current = (await secrets.get(TAVILY_KEY))?.trim();
  if (current) {
    // Both set: tavily_api_key wins, and the user.* copy stays where the principal put it.
    logger.info(
      { from: LEGACY_TAVILY_KEY, to: TAVILY_KEY },
      'Tavily key migration: tavily_api_key already set; leaving user.tavily_api_key in place',
    );
    return 'kept_existing';
  }

  // Copy first, then delete: a failure between the two leaves the key in both places
  // (harmless; the next boot reports kept_existing), never in neither.
  await secrets.set(TAVILY_KEY, legacy);
  await secrets.delete(LEGACY_TAVILY_KEY);
  logger.info(
    { from: LEGACY_TAVILY_KEY, to: TAVILY_KEY },
    'Tavily key migration: moved the Tavily key so web-search can read it',
  );
  return 'moved';
}
