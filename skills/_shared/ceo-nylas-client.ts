// Re-export: the client lives in src/channels/email so the principal-mailboxes service can
// build it without handing credentials to skill code (F7). One module, one folder cache.
export * from '../../src/channels/email/ceo-nylas-client.js';
