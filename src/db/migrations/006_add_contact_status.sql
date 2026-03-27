-- Up Migration

-- Add status column to contacts table.
-- 'confirmed' = CEO-verified, 'provisional' = auto-created awaiting confirmation, 'blocked' = rejected.
-- Existing contacts default to 'confirmed' since they were created before the status system.
ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';

-- Index for filtering by status (e.g., listing all provisional contacts for CEO review)
CREATE INDEX idx_contacts_status ON contacts (status) WHERE status != 'confirmed';
