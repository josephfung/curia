// src/registry/channel-reconcile.ts
// Startup reconciliation for the channel registry:
//   - http/cli (non-toggleable) are ALWAYS present and enabled — operator-lockout safeguard.
//   - toggleable channels with no row whose credentials resolve are installed + enabled, so
//     existing deployments light up unchanged. Existing admin state is never overwritten.
import type { Logger } from '../logger.js';
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { CredentialStatusFn } from './channel-registry-service.js';
import type { IChannelRegistryRepo } from './channel-registry-types.js';

export interface ReconcileChannelDeps {
  repo: IChannelRegistryRepo;
  catalog: ChannelDescriptor[];
  credentialStatus: CredentialStatusFn;
  logger: Logger;
}

export async function reconcileChannelRegistry(deps: ReconcileChannelDeps): Promise<void> {
  const { repo, catalog, credentialStatus, logger } = deps;
  const existing = new Map((await repo.listRows()).map(r => [r.name, r]));

  for (const d of catalog) {
    const row = existing.get(d.name);

    // Always-on channels: ensure present + enabled, regardless of prior state.
    if (!d.isToggleable) {
      if (!row) {
        await repo.install(d.name, 'reconciliation', false);
        await repo.enable(d.name, 'reconciliation');
        logger.info({ channel: d.name }, 'channel registry: enrolled always-on channel as enabled');
      } else if (!row.enabled) {
        await repo.enable(d.name, 'reconciliation');
        logger.warn({ channel: d.name }, 'channel registry: re-enabled always-on channel that was disabled');
      }
      continue;
    }

    // Toggleable channels: respect any existing admin state.
    if (row) continue;

    const status = await credentialStatus(d);
    if (status.requiredResolvable) {
      await repo.install(d.name, 'reconciliation', true);
      await repo.enable(d.name, 'reconciliation');
      logger.info({ channel: d.name }, 'channel registry: enrolled channel with resolvable credentials as enabled');
    } else {
      logger.info({ channel: d.name }, 'channel registry: channel has no credentials; left uninstalled');
    }
  }
}
