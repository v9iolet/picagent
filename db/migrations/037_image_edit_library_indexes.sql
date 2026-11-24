CREATE INDEX IF NOT EXISTS image_edit_child_tasks_source_card_id_idx
  ON suite_workbench.image_edit_child_tasks (source_card_id);

DROP INDEX IF EXISTS suite_workbench.image_edit_versions_created_at_idx;
