INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
VALUES (gen_random_uuid(), 'image-editor.restore_product', '图片编辑 · 商品还原', 'repair', 'task_image', 'image_model')
ON CONFLICT (code) DO NOTHING;

WITH defaults(body, instruction) AS (
  VALUES (
    '仅修正待编辑图中的商品外观，保持原图的构图、背景、文字、版式和光影不变。',
    '以提供的商品外观依据图还原商品的形状、结构比例、颜色、材质、细节和可见标识，保持商品在原构图中的位置和视角。不可补造依据图无法确认的配件、标识或细节。'
  )
), seeded AS (
  INSERT INTO prompt_library.prompt_template_versions (
    id, template_id, version_no, name, kind, stage, execution_target,
    input_schema, output_schema, applicability, body, user_prompt_template, status,
    source_file, source_heading, source_sha256, published_at
  )
  SELECT gen_random_uuid(), t.id, 1, t.name, t.kind, t.stage, t.execution_target,
    '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, d.body, d.instruction, 'published',
    'prompt/normalized/general-repair-product-drift.md', t.name,
    encode(digest(d.body || d.instruction, 'sha256'), 'hex'), now()
  FROM defaults d
  JOIN prompt_library.prompt_templates t ON t.code = 'image-editor.restore_product'
  WHERE NOT EXISTS (SELECT 1 FROM prompt_library.prompt_template_versions v WHERE v.template_id = t.id)
  RETURNING id, template_id
)
UPDATE prompt_library.prompt_templates t
SET published_version_id = seeded.id
FROM seeded
WHERE t.id = seeded.template_id;
