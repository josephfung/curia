-- Up Migration
-- Mark the user turns Curia wrote to itself (#1892).
--
-- Several paths re-enter an agent by writing a task brief that lands in
-- working_memory as role = 'user' with a null sender: the voice opening cue, the
-- outbound content-filter rewrite brief, a late specialist result, and the
-- secret-capture resume. They are indistinguishable from an unattributed human
-- message once stored, and two readers need to tell them apart:
--
--   1. The contact-recent shared-conversation check reads an unattributed user
--      row as another participant and closes that conversation to recall. The
--      check has no time filter and no archived filter, so one such row closes
--      it permanently.
--   2. The Signal/SMS sender backfill stamps by conversation-id pattern alone
--      and would attribute these rows to the human peer, after which recall
--      surfaces Curia's own control messages as that person's words.
--
-- Why a column rather than matching on content: the code that mints the turn
-- knows for certain what it is, and only content survived to the reader. Content
-- matching is a lossy reconstruction of that fact, and a lossy one in the
-- dangerous direction — an inbound message whose text happens to open with a
-- known marker would be excluded from the shared check, letting assistant
-- replies that quote that person reach a different contact's recall block. The
-- message body is attacker-controlled, so that is a live audience-leak surface.
-- Writers set this column instead, and an unmarked path defaults to false, which
-- means "treat as a participant" — the fail-closed direction.
--
-- Content markers are used exactly once, below, to classify rows already stored,
-- where the same false positive is a bounded one-time event on existing data
-- rather than a standing predicate on attacker-controlled input. They are the
-- SQL twin of SYNTHETIC_USER_TURN_MARKERS in src/memory/synthetic-user-turn.ts.
-- A marker added later needs its OWN migration: node-pg-migrate records this one
-- as run, so editing it would silently do nothing for any existing database.

ALTER TABLE working_memory
  ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT false;

UPDATE working_memory
SET synthetic = true
WHERE role = 'user'
  AND synthetic = false
  AND (
    content LIKE '[Call connected — open the conversation.]%'
    OR content LIKE '[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]%'
    OR content LIKE '[Late specialist result — %'
    OR content LIKE 'The secret ''%'' was just captured and saved to the vault.%'
    OR content LIKE 'The secret ''%'' that a specialist asked for was just captured and saved to the vault.%'
  );

-- Migration 090 ran before this one and had no such filter, so on any database
-- that already applied it these rows carry the human peer's contact id. Clear
-- it: a synthetic row has no sender, and leaving the stamp would recall Curia's
-- own brief as something that person said. Idempotent — a database where 090
-- stamped nothing matches no rows here.
UPDATE working_memory
SET sender_contact_id = NULL
WHERE role = 'user'
  AND synthetic = true
  AND sender_contact_id IS NOT NULL;

-- The shared-conversation check reads every user row in a participated
-- conversation, including archived ones, so this cannot be a partial index on
-- archived = false the way idx_wm_sender_active is.
CREATE INDEX idx_wm_synthetic_user
  ON working_memory (conversation_id, agent_id)
  WHERE role = 'user' AND synthetic = true;

-- Down Migration
-- Dropping the column loses the classification; the sender ids cleared above are
-- not restored, because the value they held was wrong.
DROP INDEX IF EXISTS idx_wm_synthetic_user;
ALTER TABLE working_memory DROP COLUMN IF EXISTS synthetic;
