ALTER TABLE suite_workbench.suites
  DROP CONSTRAINT IF EXISTS suites_origin_check;
ALTER TABLE suite_workbench.suites
  ADD CONSTRAINT suites_origin_check CHECK (origin IN ('suite_studio', 'canvas', 'replica'));

CREATE TABLE IF NOT EXISTS suite_workbench.replica_references (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL REFERENCES suite_workbench.suites(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  filename text NOT NULL,
  mime_type text NOT NULL,
  sha256 char(64) NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  object_key text NOT NULL,
  thumbnail_object_key text NOT NULL,
  remark text DEFAULT '' CHECK (char_length(remark) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id, ordinal),
  UNIQUE (suite_id, sha256)
);

CREATE TABLE IF NOT EXISTS suite_workbench.replica_product_images (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL REFERENCES suite_workbench.suites(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  source_kind text NOT NULL CHECK (source_kind IN ('upload', 'library')),
  object_key text NOT NULL,
  thumbnail_object_key text,
  filename text,
  mime_type text,
  sha256 char(64),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  library_resource_id text,
  resource_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (suite_id, ordinal)
);

ALTER TABLE suite_workbench.suite_tasks
  ADD COLUMN IF NOT EXISTS replica_reference_id uuid REFERENCES suite_workbench.replica_references(id) ON DELETE RESTRICT;
ALTER TABLE suite_workbench.suite_tasks
  ADD COLUMN IF NOT EXISTS replica_reference_object_key text;
ALTER TABLE suite_workbench.suite_tasks
  DROP CONSTRAINT IF EXISTS suite_tasks_origin_kind_check;
ALTER TABLE suite_workbench.suite_tasks
  ADD CONSTRAINT suite_tasks_origin_kind_check CHECK (origin_kind IN ('suite_plan', 'reverse_import', 'replica'));
CREATE INDEX IF NOT EXISTS suite_tasks_replica_reference_idx
  ON suite_workbench.suite_tasks (suite_id, replica_reference_id)
  WHERE origin_kind = 'replica';

ALTER TABLE suite_workbench.suite_pipeline_runs
  DROP CONSTRAINT IF EXISTS suite_pipeline_runs_current_phase_check;
ALTER TABLE suite_workbench.suite_pipeline_runs
  ADD CONSTRAINT suite_pipeline_runs_current_phase_check
  CHECK (current_phase IN ('base_refining', 'structure_planning', 'category_prompting', 'image_generating', 'replica_analyzing', 'done'));
