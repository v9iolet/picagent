DO $$
DECLARE
  previous prompt_library.prompt_template_versions%ROWTYPE;
  next_version_id uuid := gen_random_uuid();
  next_name text := '图片编辑 · 编辑文字';
  instruction text := '仅编辑下列文字。按原文字和位置找到每一条，准确替换为 newText，保持原有排版、字体风格、颜色、透视与光影。newText 为空时移除原文字，用周围背景自然填补，延续纹理和光影。坐标相对整张图归一化，以左上角为原点。';
BEGIN
  SELECT v.* INTO previous
  FROM prompt_library.prompt_templates t
  JOIN prompt_library.prompt_template_versions v ON v.id = t.published_version_id
  WHERE t.code = 'image-editor.change_text' AND t.lifecycle_status = 'active'
    AND v.source_file = 'db/migrations/042_image_editor_submission.sql'
    AND v.version_no = 1 AND v.status = 'published'
  FOR UPDATE OF v;

  -- Upgrade the seeded default. Keep a user-published version or a disabled template as-is.
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM prompt_library.prompt_template_versions
    WHERE template_id = previous.template_id
      AND source_file = 'db/migrations/045_image_editor_change_text_list.sql'
  ) THEN
    RETURN;
  END IF;

  UPDATE prompt_library.prompt_template_versions SET status = 'retired' WHERE id = previous.id;

  INSERT INTO prompt_library.prompt_template_versions (
    id, template_id, version_no, name, kind, stage, execution_target,
    input_schema, output_schema, applicability, body, user_prompt_template, status,
    source_file, source_heading, source_sha256, published_at
  )
  SELECT next_version_id, previous.template_id, MAX(version_no) + 1,
    next_name, previous.kind, previous.stage, previous.execution_target,
    previous.input_schema, previous.output_schema, previous.applicability, previous.body, instruction, 'published',
    'db/migrations/045_image_editor_change_text_list.sql', next_name,
    encode(digest(previous.body || instruction, 'sha256'), 'hex'), now()
  FROM prompt_library.prompt_template_versions WHERE template_id = previous.template_id;

  UPDATE prompt_library.prompt_templates SET name = next_name, published_version_id = next_version_id
  WHERE id = previous.template_id;
END $$;
