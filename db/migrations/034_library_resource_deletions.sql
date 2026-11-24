CREATE TABLE IF NOT EXISTS suite_workbench.library_resource_deletions (
  resource_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS library_resource_deletions_deleted_at_idx
  ON suite_workbench.library_resource_deletions (deleted_at DESC);
