ALTER TABLE suite_workbench.suites
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'suite_studio';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suites_origin_check') THEN
    ALTER TABLE suite_workbench.suites ADD CONSTRAINT suites_origin_check CHECK (origin IN ('suite_studio', 'canvas'));
  END IF;
END $$;
UPDATE suite_workbench.suites AS s
SET origin = 'canvas'
WHERE s.origin = 'suite_studio'
  AND NOT EXISTS (SELECT 1 FROM suite_workbench.plan_snapshots p WHERE p.suite_id = s.id)
  AND EXISTS (SELECT 1 FROM suite_workbench.suite_tasks t WHERE t.suite_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM suite_workbench.suite_tasks t WHERE t.suite_id = s.id AND COALESCE(t.origin_kind, 'suite_plan') <> 'reverse_import');

ALTER TABLE suite_workbench.plan_snapshots
  ADD COLUMN IF NOT EXISTS confirmation_mode text NOT NULL DEFAULT 'human';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_snapshots_confirmation_mode_check') THEN
    ALTER TABLE suite_workbench.plan_snapshots ADD CONSTRAINT plan_snapshots_confirmation_mode_check CHECK (confirmation_mode IN ('auto', 'human'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS suite_workbench.suite_pipeline_runs (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL REFERENCES suite_workbench.suites(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'waiting_base_refine_decision', 'waiting_human_input', 'completed', 'partial_failed', 'failed')),
  current_phase text NOT NULL CHECK (current_phase IN ('base_refining', 'structure_planning', 'category_prompting', 'image_generating', 'done')),
  resume_count integer NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
  last_resume_key text,
  structure_snapshot_id uuid REFERENCES suite_workbench.plan_snapshots(id) ON DELETE SET NULL,
  task_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (suite_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS suite_pipeline_runs_suite_created_idx ON suite_workbench.suite_pipeline_runs(suite_id, created_at DESC);
ALTER TABLE suite_workbench.suite_pipeline_runs ADD COLUMN IF NOT EXISTS resume_count integer NOT NULL DEFAULT 0;
ALTER TABLE suite_workbench.suite_pipeline_runs ADD COLUMN IF NOT EXISTS last_resume_key text;
ALTER TABLE suite_workbench.suite_pipeline_runs ADD COLUMN IF NOT EXISTS structure_snapshot_id uuid REFERENCES suite_workbench.plan_snapshots(id) ON DELETE SET NULL;
ALTER TABLE suite_workbench.suite_pipeline_runs ADD COLUMN IF NOT EXISTS task_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb;
