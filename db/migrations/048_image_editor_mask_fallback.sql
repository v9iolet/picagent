DO $$
DECLARE
  previous record;
  next_version_id uuid;
BEGIN
  FOR previous IN
    SELECT v.*, seed.instruction
    FROM (VALUES
      ('image-editor.redraw', '仅重绘{{region}}{{requirement}}，选区以外的商品与背景画面严格保持不变。'),
      ('image-editor.erase', '仅消除{{region}}中的目标并自然补全周围背景{{requirement}}，选区以外画面严格保持不变。'),
      ('image-editor.outpaint', '仅补全灰色扩展区，自然延续原图边缘的背景纹理、光影与透视，保持原图画面不变{{requirement}}。')
    ) AS seed(code, instruction)
    JOIN prompt_library.prompt_templates t ON t.code = seed.code
    JOIN prompt_library.prompt_template_versions v ON v.id = t.published_version_id
    WHERE t.lifecycle_status = 'active' AND v.status = 'published'
      AND v.version_no = 1 AND v.source_file = 'db/migrations/042_image_editor_submission.sql'
      AND NOT EXISTS (
        SELECT 1 FROM prompt_library.prompt_template_versions v2
        WHERE v2.template_id = t.id AND v2.source_file = 'db/migrations/048_image_editor_mask_fallback.sql'
      )
    FOR UPDATE OF t, v
  LOOP
    next_version_id := gen_random_uuid();
    UPDATE prompt_library.prompt_template_versions SET status = 'retired' WHERE id = previous.id;

    INSERT INTO prompt_library.prompt_template_versions (
      id, template_id, version_no, name, kind, stage, execution_target,
      input_schema, output_schema, applicability, body, user_prompt_template, status,
      source_file, source_heading, source_sha256, published_at
    )
    SELECT next_version_id, previous.template_id, MAX(version_no) + 1,
      previous.name, previous.kind, previous.stage, previous.execution_target,
      previous.input_schema, previous.output_schema, previous.applicability, previous.body, previous.instruction, 'published',
      'db/migrations/048_image_editor_mask_fallback.sql', previous.source_heading,
      encode(digest(previous.body || previous.instruction, 'sha256'), 'hex'), now()
    FROM prompt_library.prompt_template_versions WHERE template_id = previous.template_id;

    UPDATE prompt_library.prompt_templates SET published_version_id = next_version_id WHERE id = previous.template_id;
  END LOOP;
END $$;
