ALTER TABLE suite_workbench.image_edit_versions
  ADD COLUMN IF NOT EXISTS generated_size_json jsonb,
  ADD COLUMN IF NOT EXISTS delivery_size_json jsonb,
  ADD COLUMN IF NOT EXISTS delivery_object_key text;
