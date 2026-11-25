ALTER TABLE suite_workbench.image_edit_snapshots
  ADD COLUMN IF NOT EXISTS tool text,
  ADD COLUMN IF NOT EXISTS attached_inputs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mask_applied boolean,
  ADD COLUMN IF NOT EXISTS prompt_template_version_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'suite_workbench.image_edit_snapshots'::regclass
      AND conname = 'image_edit_snapshots_prompt_template_version_fk'
  ) THEN
    ALTER TABLE suite_workbench.image_edit_snapshots
      ADD CONSTRAINT image_edit_snapshots_prompt_template_version_fk
      FOREIGN KEY (prompt_template_version_id) REFERENCES prompt_library.prompt_template_versions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'suite_workbench.image_edit_snapshots'::regclass
      AND conname = 'image_edit_snapshots_attached_inputs_array'
  ) THEN
    ALTER TABLE suite_workbench.image_edit_snapshots
      ADD CONSTRAINT image_edit_snapshots_attached_inputs_array
      CHECK (jsonb_typeof(attached_inputs_json) = 'array');
  END IF;
END $$;

INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
VALUES
  (gen_random_uuid(), 'image-editor.add_text', '图片编辑 · 添加文字', 'repair', 'task_image', 'image_model'),
  (gen_random_uuid(), 'image-editor.change_text', '图片编辑 · 改文字', 'repair', 'task_image', 'image_model'),
  (gen_random_uuid(), 'image-editor.redraw', '图片编辑 · 局部重绘', 'repair', 'task_image', 'image_model'),
  (gen_random_uuid(), 'image-editor.erase', '图片编辑 · 消除', 'repair', 'task_image', 'image_model'),
  (gen_random_uuid(), 'image-editor.outpaint', '图片编辑 · 扩图', 'repair', 'task_image', 'image_model')
ON CONFLICT (code) DO NOTHING;

WITH instructions(code, instruction) AS (
  VALUES
    ('image-editor.add_text', '在{{region}}新增文字“{{text}}”{{requirement}}。'),
    ('image-editor.change_text', '将{{region}}的原文字“{{originalText}}”替换为“{{newText}}”，保持原有排版、字体风格、颜色与光影一致{{requirement}}。'),
    ('image-editor.redraw', '仅重绘蒙版白色选区{{requirement}}，蒙版以外的商品与背景画面严格保持不变。'),
    ('image-editor.erase', '仅消除蒙版白色选区中的目标并自然补全周围背景{{requirement}}，蒙版以外画面严格保持不变。'),
    ('image-editor.outpaint', '{{direction}}扩展画面至比例 {{ratio}}{{dimensions}}，原图主体锚点保持{{anchor}}并自然延续背景纹理与光影{{requirement}}。')
), defaults AS (
  SELECT code, instruction,
    '严格保持输入图片中的商品主体外观、结构比例、材质细节、光影色调、背景构图及未指定修改的文字与元素不变，仅执行以下局部修改：' AS body
  FROM instructions
), seeded AS (
  INSERT INTO prompt_library.prompt_template_versions (
    id, template_id, version_no, name, kind, stage, execution_target,
    input_schema, output_schema, applicability, body, user_prompt_template, status,
    source_file, source_heading, source_sha256, published_at
  )
  SELECT gen_random_uuid(), t.id, 1, t.name, t.kind, t.stage, t.execution_target,
    '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, d.body, d.instruction, 'published',
    'db/migrations/042_image_editor_submission.sql', t.name, encode(digest(d.body || d.instruction, 'sha256'), 'hex'), now()
  FROM defaults d
  JOIN prompt_library.prompt_templates t ON t.code = d.code
  WHERE NOT EXISTS (SELECT 1 FROM prompt_library.prompt_template_versions v WHERE v.template_id = t.id)
  RETURNING id, template_id
)
UPDATE prompt_library.prompt_templates t
SET published_version_id = seeded.id
FROM seeded
WHERE t.id = seeded.template_id;
