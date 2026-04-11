-- Up Migration

-- Add last_decayed_at to track when the DreamEngine last applied decay to each row.
--
-- Without this column the decay formula reapplies the full decay factor from
-- last_confirmed_at to the already-decayed confidence on every run, compounding
-- faster than intended. With last_decayed_at, each run only applies decay for
-- the interval since the previous run:
--
--   new_confidence = confidence
--                    × 0.5^(days_since_last_decayed / half_life_days)
--
-- Incremental decay is mathematically equivalent to continuous decay:
--   0.8 × 0.5^(d1/T) × 0.5^(d2/T) = 0.8 × 0.5^((d1+d2)/T)
--
-- Defaults to NULL so COALESCE(last_decayed_at, last_confirmed_at) is used on
-- the first pass — no backfill required.

ALTER TABLE kg_nodes ADD COLUMN last_decayed_at TIMESTAMPTZ;
ALTER TABLE kg_edges ADD COLUMN last_decayed_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE kg_nodes DROP COLUMN IF EXISTS last_decayed_at;
ALTER TABLE kg_edges DROP COLUMN IF EXISTS last_decayed_at;
