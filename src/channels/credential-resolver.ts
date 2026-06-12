// src/channels/credential-resolver.ts
// Vault-first credential resolution for channels. Precedence per field:
//   vault  (channel.<name>.<key>)  ▸  env (field.envFallback)  ▸  config (caller-supplied)  ▸  missing
// Config resolution lives in the caller (index.ts) because it depends on already-parsed
// config shapes (e.g. multi-account email); the caller passes the satisfied key names in.
import type { ChannelDescriptor } from './catalog.js';

export type CredentialSource = 'vault' | 'env' | 'config' | 'missing';

export interface CredentialFieldStatus {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: CredentialSource;
}

export interface CredentialResolverDeps {
  /** Narrow view of the vault — only get() is needed. */
  secrets: { get(name: string): Promise<string | null> };
  /** Defaults to process.env. Injected in tests. */
  env?: Record<string, string | undefined>;
  /** Required keys the caller considers satisfied via config/default.yaml (e.g. email accounts). */
  configResolvedKeys?: Set<string>;
}

export interface ChannelCredentialStatus {
  fields: CredentialFieldStatus[];
  /** True when every requiredSecretKeys entry resolves from some source. */
  requiredResolvable: boolean;
}

export async function channelCredentialStatus(
  deps: CredentialResolverDeps,
  descriptor: ChannelDescriptor,
): Promise<ChannelCredentialStatus> {
  const env = deps.env ?? process.env;
  const configKeys = deps.configResolvedKeys ?? new Set<string>();
  const fields: CredentialFieldStatus[] = [];

  for (const field of descriptor.credentialFields) {
    const vaultVal = await deps.secrets.get(`channel.${descriptor.name}.${field.key}`);
    let source: CredentialSource;
    if (vaultVal) source = 'vault';
    else if (field.envFallback && env[field.envFallback]) source = 'env';
    else if (configKeys.has(field.key)) source = 'config';
    else source = 'missing';

    fields.push({ key: field.key, label: field.label, secret: field.secret, configured: source !== 'missing', source });
  }

  const byKey = new Map(fields.map(f => [f.key, f]));
  const requiredResolvable = descriptor.requiredSecretKeys.every(k => byKey.get(k)?.configured === true);
  return { fields, requiredResolvable };
}
