-- Upgrade only the original active, published 043 template. Startup replays this migration.
DO $$
DECLARE
  previous prompt_library.prompt_template_versions%ROWTYPE;
  next_id CONSTANT uuid := '8fd5d02a-eb5d-57cf-b384-9dbf35ad1c27';
BEGIN
  SELECT v.* INTO previous
  FROM prompt_library.prompt_templates t
  JOIN prompt_library.prompt_template_versions v ON v.id = t.published_version_id
  WHERE t.code = 'aplus.ai-write' AND t.lifecycle_status = 'active'
    AND v.id = 'c4a39569-9f21-5d8f-addc-8aed2ba16314' AND v.status = 'published'
    AND NOT EXISTS (SELECT 1 FROM prompt_library.prompt_template_versions WHERE id = next_id)
  FOR UPDATE OF t, v;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE prompt_library.prompt_template_versions SET status = 'retired' WHERE id = previous.id;

  INSERT INTO prompt_library.prompt_template_versions (
    id, template_id, version_no, name, kind, stage, execution_target, input_schema, output_schema,
    applicability, body, user_prompt_template, status, source_file, source_heading, source_sha256, published_at
  )
  SELECT next_id, previous.template_id, MAX(version_no) + 1,
    previous.name, previous.kind, previous.stage, previous.execution_target,
    '[{"key":"inputImageIds","label":"商品原图对应顺序","type":"textarea","required":true,"order":0},{"key":"productCardFacts","label":"商品卡事实","type":"textarea","required":true,"order":1},{"key":"productInfo","label":"已有草稿与画面偏好","type":"textarea","required":false,"order":2},{"key":"platform","label":"目标平台","type":"text","required":true,"order":3},{"key":"targetMarket","label":"目标市场","type":"text","required":true,"order":4},{"key":"language","label":"画面文字语言","type":"text","required":true,"order":5}]'::jsonb,
    previous.output_schema, previous.applicability,
    $prompt$你是电商详情页的视觉策划。对照按顺序附上的商品原图与商品卡中已确认的客观事实，为本批图片写 3–5 条补充卖点与视觉呈现方向。每条先指出原图中能看见的特征，再说明画面可以怎样突出它。按实际素材选择视角、开合或组装状态、局部细节、可见配件或置景，不要求逐项覆盖。

商品事实仅取自原图与商品卡。严禁编造参数、性能、数量、材质、认证或功效。保留用户已有的构图、色调和画面侧重点，把它们作为本次作图要求。不要抄写整张商品卡，不输出五段式表单、缺失字段或任何待补充占位符。

每条单独一行，使用表单语言输出可直接回填的纯文本，限 1000 字。目标平台、市场和画面文字语言用于理解呈现要求；即使画面不加文字，也应给出视觉建议。$prompt$,
    $prompt$商品原图对应顺序：{{inputImageIds}}
商品卡事实：{{productCardFacts}}
已有草稿与画面偏好：{{productInfo}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
画面文字语言：{{language}}$prompt$,
    'published', previous.source_file, previous.source_heading,
    '348a7199aad565638c3bb2b1c9379a7ab13d4ac74e44f6140b85e8a7023b68e2', now()
  FROM prompt_library.prompt_template_versions WHERE template_id = previous.template_id;

  UPDATE prompt_library.prompt_templates SET published_version_id = next_id WHERE id = previous.template_id;
END $$;
