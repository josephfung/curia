-- Migration 068: consolidate the Signal phone number onto one authoritative vault key,
-- channel.signal.phone_number (#1140).
--
-- The number was read from two divergent vault keys: the legacy flat `signal_phone_number`
-- (read by applyVaultSecrets) and the namespaced `channel.signal.phone_number` (written by
-- the console, read by the registry gate and applyChannelVaultSecrets). Only the namespaced
-- key gates inbound Signal activation, so a flat-key-only deployment could enable outbound
-- Signal egress while the registry reported Signal unconfigured. We standardize on the
-- namespaced key and remove the flat-key read in the same change.
--
-- This migration backfills any existing flat value onto the namespaced key, then drops the
-- flat row. Safe to run on every deployment:
--   * Copies encrypted_value + iv verbatim — the vault's AES-256-GCM encryption uses no
--     per-name AAD (src/secrets/crypto.ts), so the ciphertext decrypts identically under the
--     new name. No encryption key is needed here.
--   * The NOT EXISTS guard never clobbers a value already written via the console.
--   * Idempotent: a second run copies nothing (guard) and deletes nothing (row already gone).
--   * No-op for env-only or console-only deployments that never had the flat key.

INSERT INTO secrets (name, value_format, encrypted_value, iv)
SELECT 'channel.signal.phone_number', value_format, encrypted_value, iv
FROM secrets
WHERE name = 'signal_phone_number'
  AND NOT EXISTS (
    SELECT 1 FROM secrets WHERE name = 'channel.signal.phone_number'
  );

DELETE FROM secrets WHERE name = 'signal_phone_number';
