-- Up Migration

-- 100_unscore_blind_approved_executions.sql
--
-- #2196: a successful re-execution of an approved action (a child row, parent_action_id
-- set) carries no task_summary, so the LLM judge scored it blind. In prod it flagged them
-- 0 on commitment and compatibility, and one of them (row 45) as a competence error. The
-- scoring pass now gives these rows no signal; this clears the flags the judge already
-- wrote so the capability score and the error-rate window stop counting them.
--
-- Only 'llm-judge' rows are touched. Failed re-executions keep their verdicts: they carry
-- the error as their summary, so the judge had something real to score.

UPDATE autonomy_action_log
   SET competence_flag = NULL,
       commitment_flag = NULL,
       compatibility   = NULL,
       scored_by       = 'deterministic-approved-execution'
 WHERE parent_action_id IS NOT NULL
   AND outcome = 'success'
   AND scored_by = 'llm-judge';

-- Down Migration

-- The judge's original flags are gone and were guesses anyway. Returning the rows to the
-- unscored queue lets the previous code re-judge them on its next pass.
UPDATE autonomy_action_log
   SET scored_by = NULL
 WHERE parent_action_id IS NOT NULL
   AND outcome = 'success'
   AND scored_by = 'deterministic-approved-execution';
