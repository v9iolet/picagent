INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
VALUES (gen_random_uuid(), 'image-editor.re_edit', '图片编辑 · AI 改图', 'repair', 'task_image', 'image_model')
ON CONFLICT (code) DO NOTHING;

WITH defaults(body, instruction) AS (
  VALUES (
    '严格保持待编辑图中未指定修改的商品主体外观、结构比例、材质细节、光影色调、背景构图、文字与元素不变。',
    '只执行以下修改：{{instruction}}'
  )
), seeded AS (
  INSERT INTO prompt_library.prompt_template_versions (
    id, template_id, version_no, name, kind, stage, execution_target,
    input_schema, output_schema, applicability, body, user_prompt_template, status,
    source_file, source_heading, source_sha256, published_at
  )
  SELECT gen_random_uuid(), t.id, 1, t.name, t.kind, t.stage, t.execution_target,
    '[{"key":"instruction","label":"调整要求","type":"textarea","required":true,"order":0}]'::jsonb,
    '{}'::jsonb, '{}'::jsonb, d.body, d.instruction, 'published',
    'db/migrations/047_image_editor_ai_edit.sql', t.name, encode(digest(d.body || d.instruction, 'sha256'), 'hex'), now()
  FROM defaults d
  JOIN prompt_library.prompt_templates t ON t.code = 'image-editor.re_edit'
  WHERE NOT EXISTS (SELECT 1 FROM prompt_library.prompt_template_versions v WHERE v.template_id = t.id)
  RETURNING id, template_id
)
UPDATE prompt_library.prompt_templates t
SET published_version_id = seeded.id
FROM seeded
WHERE t.id = seeded.template_id;
