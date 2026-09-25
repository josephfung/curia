-- Up Migration
--
-- Issue #1901: an ignored ambient @mention is shown once more, then watermarked.
--
-- injected_through is the newest message timestamp the agent was shown on a wake
-- that left the handoff untouched. seen_through stays behind, so the thread can
-- return. A later wake of the same messages (last_message_at <= injected_through)
-- stamps seen_through and the thread goes quiet.
--
-- seen_through is nullable so that injection-only row does not pretend the agent
-- has already handled the thread. A row still has to record one of the two marks.

ALTER TABLE bullpen_thread_reads
  ALTER COLUMN seen_through DROP NOT NULL;

ALTER TABLE bullpen_thread_reads
  ADD COLUMN injected_through TIMESTAMPTZ;

ALTER TABLE bullpen_thread_reads
  ADD CONSTRAINT bullpen_thread_reads_has_mark
  CHECK (seen_through IS NOT NULL OR injected_through IS NOT NULL);

-- Down Migration

ALTER TABLE bullpen_thread_reads DROP CONSTRAINT IF EXISTS bullpen_thread_reads_has_mark;

ALTER TABLE bullpen_thread_reads DROP COLUMN IF EXISTS injected_through;

-- Injection-only rows have no watermark to restore to NOT NULL.
DELETE FROM bullpen_thread_reads WHERE seen_through IS NULL;

ALTER TABLE bullpen_thread_reads
  ALTER COLUMN seen_through SET NOT NULL;
