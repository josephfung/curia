-- 078_create_sms_opt_outs.sql
-- Durable STOP/opt-out ledger for the SMS channel (US A2P). Peer E.164 only —
-- never the office DID. Cleared by inbound START/YES/UNSTOP.

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone_e164   TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source       TEXT NOT NULL DEFAULT 'inbound_stop'
);

COMMENT ON TABLE sms_opt_outs IS
  'SMS A2P opt-outs (STOP). Outbound sms-send / reply path must refuse these numbers.';
