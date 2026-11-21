ALTER TABLE suite_workbench.suites
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS suites_active_updated_idx
  ON suite_workbench.suites (updated_at DESC)
  WHERE deleted_at IS NULL;
