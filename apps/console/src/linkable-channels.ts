// Re-export the shared allowlist so console typecheck can resolve it without
// a deprecated `baseUrl`/`paths` setup. Vite resolves `@curia/linkable-channels`
// via alias; this file is the TypeScript entry for the same module (#1514).
export {
  LINKABLE_CHANNEL_IDENTITIES,
  LINKABLE_CHANNEL_IDENTITY_SET,
  type LinkableChannelIdentity,
} from '../../../src/contacts/linkable-channels.js';
