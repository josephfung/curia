-- Up Migration

-- Add message count columns for the contact confidence scoring pipeline.
-- These are scoring-owned — updated by ConfidencePipeline, not by ContactService.updateContact().
ALTER TABLE contacts ADD COLUMN inbound_message_count INT NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN outbound_message_count INT NOT NULL DEFAULT 0;

ALTER TABLE contacts ADD CONSTRAINT contacts_inbound_message_count_check
  CHECK (inbound_message_count >= 0);
ALTER TABLE contacts ADD CONSTRAINT contacts_outbound_message_count_check
  CHECK (outbound_message_count >= 0);
