-- Phase: parallel-final approval stage
-- Adds a `stage` column to task_approval_flows so multiple rows can belong to
-- the same conceptual approval step (Manager + Admin + Super Admin acting as
-- a single any-of step at the end of the chain).
--
-- `level` remains globally unique per task so each row keeps its own ID-like
-- ordering; `stage` is the grouping key the controller uses to find "the
-- current step". Sequential rows have stage = level. Parallel rows share a
-- stage value (e.g. all three final approvers carry stage = K).
--
-- Backfill makes the column safe for existing rows: stage = level for any
-- pre-existing chain, so legacy approvals continue to behave sequentially.

ALTER TABLE task_approval_flows
  ADD COLUMN IF NOT EXISTS stage INTEGER;

UPDATE task_approval_flows
  SET stage = level
  WHERE stage IS NULL;

-- Hot path for "what's the lowest pending stage on this task?"
CREATE INDEX IF NOT EXISTS task_approval_flows_task_stage_status_idx
  ON task_approval_flows ("taskId", stage, status);
