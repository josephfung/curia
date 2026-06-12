// src/channels/catalog.ts
// Static, code-defined source of truth for which channels exist, whether each is
// toggleable, and what credentials it needs. The channel_registry table holds only
// mutable lifecycle state; this catalog supplies everything structural.

export interface ChannelCredentialField {
  /** Vault key suffix: stored as `channel.<channel>.<key>`. */
  key: string;
  /** Human label for the credential form. */
  label: string;
  /** Render as a password input and never echo the value back over the API. */
  secret: boolean;
  /** Legacy env var checked during resolution (back-compat with pre-vault deployments). */
  envFallback?: string;
}

export interface ChannelDescriptor {
  name: string;
  description: string;
  /** False for http, cli — always-on, cannot be disabled/uninstalled. */
  isToggleable: boolean;
  credentialFields: ChannelCredentialField[];
  /** Subset of credentialFields[].key that must resolve before the channel can be enabled. */
  requiredSecretKeys: string[];
}

export const CHANNEL_CATALOG: ChannelDescriptor[] = [
  {
    name: 'email',
    description: 'Email channel via Nylas. Polls a connected mailbox and replies in-thread.',
    isToggleable: true,
    credentialFields: [
      { key: 'nylas_api_key', label: 'Nylas API key', secret: true, envFallback: 'NYLAS_API_KEY' },
      { key: 'nylas_grant_id', label: 'Nylas grant ID', secret: true, envFallback: 'NYLAS_GRANT_ID' },
      { key: 'nylas_self_email', label: 'Mailbox address', secret: false, envFallback: 'NYLAS_SELF_EMAIL' },
    ],
    requiredSecretKeys: ['nylas_api_key', 'nylas_grant_id', 'nylas_self_email'],
  },
  {
    name: 'signal',
    description: 'Signal channel via signal-cli JSON-RPC over a Unix socket.',
    isToggleable: true,
    credentialFields: [
      { key: 'socket_path', label: 'signal-cli socket path', secret: false, envFallback: 'SIGNAL_SOCKET_PATH' },
      { key: 'phone_number', label: 'Phone number (E.164)', secret: false, envFallback: 'SIGNAL_PHONE_NUMBER' },
    ],
    requiredSecretKeys: ['socket_path', 'phone_number'],
  },
  {
    name: 'http',
    description: 'HTTP API channel. Always on — serves the web console and API.',
    isToggleable: false,
    credentialFields: [],
    requiredSecretKeys: [],
  },
  {
    name: 'cli',
    description: 'Local CLI channel. Always on in interactive sessions; cannot be disabled.',
    isToggleable: false,
    credentialFields: [],
    requiredSecretKeys: [],
  },
];

export function getChannelDescriptor(name: string): ChannelDescriptor | undefined {
  return CHANNEL_CATALOG.find(c => c.name === name);
}
