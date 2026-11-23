-- Retire prompt templates not referenced by any active runtime workflow
-- (legacy one-shot `plan`, unused `task_image` repair templates, and read-only `reverse_prompt` templates).
-- Keep all template and version rows intact so historical references remain readable by ID.

UPDATE prompt_library.prompt_templates t
SET published_version_id = NULL
WHERE t.published_version_id IS NOT NULL
  AND (
    t.stage IN ('plan', 'task_image', 'reverse_prompt')
    OR EXISTS (
      SELECT 1
      FROM prompt_library.prompt_template_versions v
      WHERE v.id = t.published_version_id
        AND v.stage IN ('plan', 'task_image', 'reverse_prompt')
    )
  );

UPDATE prompt_library.prompt_template_versions v
SET status = 'retired'
WHERE v.status = 'published'
  AND v.stage IN ('plan', 'task_image', 'reverse_prompt');
