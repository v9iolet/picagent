CREATE TABLE IF NOT EXISTS suite_workbench.model_settings (
  singleton boolean PRIMARY KEY CHECK (singleton),
  state jsonb NOT NULL
);

INSERT INTO suite_workbench.model_settings (singleton, state)
VALUES (true, '{"channels":[],"preferences":{"image":null,"vision":null}}')
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE suite_workbench.generation_attempts
  DROP CONSTRAINT IF EXISTS generation_attempts_model_check,
  ADD COLUMN IF NOT EXISTS channel_snapshot_json jsonb;

ALTER TABLE suite_workbench.image_edit_ocr_snapshots
  ADD COLUMN IF NOT EXISTS provider_json jsonb;

ALTER TABLE suite_workbench.plan_generation_attempts
  ADD COLUMN IF NOT EXISTS channel_snapshot_json jsonb;

ALTER TABLE suite_workbench.plan_snapshots
  ADD COLUMN IF NOT EXISTS channel_snapshot_json jsonb;

ALTER TABLE suite_workbench.plan_category_requests
  ADD COLUMN IF NOT EXISTS channel_snapshot_json jsonb;
