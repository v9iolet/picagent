-- Upgrade only the original active, published 051 template. Startup replays this migration.
DO $$
DECLARE
  previous prompt_library.prompt_template_versions%ROWTYPE;
  next_id CONSTANT uuid := 'f3793c59-06cb-520b-8388-db6267d15b35';
BEGIN
  SELECT v.* INTO previous
  FROM prompt_library.prompt_templates t
  JOIN prompt_library.prompt_template_versions v ON v.id = t.published_version_id
  WHERE t.code = 'aplus.ai-write' AND t.lifecycle_status = 'active'
    AND v.id = '8fd5d02a-eb5d-57cf-b384-9dbf35ad1c27' AND v.status = 'published'
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
    $prompt$你只为本批 A+ 详情图提供视觉策划。禁止输出亚马逊或其他平台的纯白底主图拍摄建议、主图合规建议。对照按顺序附上的商品原图与商品卡事实，从可见的视角、开合或组装状态、局部细节中提炼核心补充亮点，说明怎样通过取景、布光或构图呈现它。

商品事实仅取自原图与商品卡。照片边缘、桌面或背景中无法确认归属的线状物、道具或杂物，不得写成随货线缆、赠品或配件。严禁编造参数、性能、数量、材质、认证或功效。保留已有草稿中的构图、色调和画面偏好，不抄写整张商品卡，不输出五段式表单、缺失字段或待补充占位符。

用表单语言输出 3–4 条精炼要点，总长控制在 300 字以内。每条单独一行，直接写“核心补充亮点 + 画面呈现方向”，避免重复堆砌英文角标。结合目标平台、市场和画面文字语言选择呈现方式，即使画面不加文字也要给出视觉建议。$prompt$,
    $prompt$商品原图对应顺序：{{inputImageIds}}
商品卡事实：{{productCardFacts}}
已有草稿与画面偏好：{{productInfo}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
画面文字语言：{{language}}$prompt$,
    'published', previous.source_file, previous.source_heading,
    '55559b6bf59633ea7d26c7d4c1aa849bbdfcff840df5a001caa18d2586cd6f17', now()
  FROM prompt_library.prompt_template_versions WHERE template_id = previous.template_id;

  UPDATE prompt_library.prompt_templates SET published_version_id = next_id WHERE id = previous.template_id;
END $$;

UPDATE suite_workbench.model_settings
SET state = jsonb_set(state, '{preferences,video}', 'null'::jsonb)
WHERE singleton AND NOT (state->'preferences' ? 'video');
