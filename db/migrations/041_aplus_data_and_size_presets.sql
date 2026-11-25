ALTER TABLE suite_workbench.suites
  DROP CONSTRAINT IF EXISTS suites_origin_check,
  ADD CONSTRAINT suites_origin_check CHECK (origin IN ('suite_studio', 'canvas', 'replica', 'aplus'));

ALTER TABLE suite_workbench.suite_tasks
  DROP CONSTRAINT IF EXISTS suite_tasks_origin_kind_check,
  ADD CONSTRAINT suite_tasks_origin_kind_check CHECK (origin_kind IN ('suite_plan', 'reverse_import', 'replica', 'aplus')),
  ADD COLUMN IF NOT EXISTS module_code text,
  ADD COLUMN IF NOT EXISTS size_preset text,
  ADD COLUMN IF NOT EXISTS sort_order integer;

ALTER TABLE suite_workbench.task_image_versions
  ADD COLUMN IF NOT EXISTS generated_size_json jsonb,
  ADD COLUMN IF NOT EXISTS delivery_size_json jsonb,
  ADD COLUMN IF NOT EXISTS delivery_object_key text;

ALTER TABLE suite_workbench.suite_pipeline_runs
  DROP CONSTRAINT IF EXISTS suite_pipeline_runs_current_phase_check,
  ADD CONSTRAINT suite_pipeline_runs_current_phase_check CHECK (current_phase IN (
    'base_refining', 'structure_planning', 'category_prompting', 'image_generating',
    'replica_analyzing', 'aplus_planning', 'awaiting_confirmation', 'done'
  ));

ALTER TABLE prompt_library.prompt_templates
  DROP CONSTRAINT IF EXISTS prompt_templates_stage_check,
  ADD CONSTRAINT prompt_templates_stage_check CHECK (stage IN (
    'base_refine', 'plan', 'structure_plan', 'category_prompt', 'task_image', 'reverse_prompt',
    'listing_copy', 'replica_prompt', 'product_onboarding', 'aplus_plan', 'aplus_module_rule',
    'aplus_image', 'aplus_ai_write'
  ));

ALTER TABLE prompt_library.prompt_template_versions
  DROP CONSTRAINT IF EXISTS prompt_template_versions_stage_check,
  ADD CONSTRAINT prompt_template_versions_stage_check CHECK (stage IN (
    'base_refine', 'plan', 'structure_plan', 'category_prompt', 'task_image', 'reverse_prompt',
    'listing_copy', 'replica_prompt', 'product_onboarding', 'aplus_plan', 'aplus_module_rule',
    'aplus_image', 'aplus_ai_write'
  ));

ALTER TABLE suite_workbench.platform_profiles
  ADD COLUMN IF NOT EXISTS detail_size_presets jsonb;

-- Startup replays migrations. Keep any platform configuration already in place.
UPDATE suite_workbench.platform_profiles
SET detail_size_presets = CASE
  WHEN code = 'amazon' THEN '{"options":["aplus_premium_web","aplus_premium_mobile","aplus_standard","1:1","3:4","9:16","16:9"],"default":"aplus_standard"}'::jsonb
  WHEN market_scope = 'domestic' THEN '{"options":["1:1","3:4","9:16","16:9"],"default":"3:4"}'::jsonb
  ELSE '{"options":["1:1","3:4","9:16","16:9"],"default":"1:1"}'::jsonb
END
WHERE detail_size_presets IS NULL;

ALTER TABLE suite_workbench.platform_profiles
  ALTER COLUMN detail_size_presets SET DEFAULT '{"options":["1:1","3:4","9:16","16:9"],"default":"1:1"}'::jsonb,
  ALTER COLUMN detail_size_presets SET NOT NULL;
