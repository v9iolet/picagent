ALTER TABLE suite_workbench.suites
  ADD COLUMN IF NOT EXISTS style_override TEXT,
  ADD COLUMN IF NOT EXISTS style_override_updated_at TIMESTAMPTZ;
