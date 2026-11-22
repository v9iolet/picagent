WITH rule(strategy, marker) AS (
  VALUES (
    '主图必须使用纯白背景（RGB 255,255,255），商品主体完整清晰，不得添加文字、Logo、水印、边框或装饰。',
    '[主图背景规范 v2]'
  )
)
UPDATE suite_workbench.platform_profiles
SET main_image_background = 'pure_white_required',
    main_image_strategy = rule.strategy,
    source_note = CASE
      WHEN position(rule.marker IN source_note) > 0 THEN source_note
      ELSE concat_ws(' ', NULLIF(source_note, ''), rule.marker)
    END,
    updated_at = now()
FROM rule
WHERE market_scope = 'overseas'
  AND (
    main_image_background <> 'pure_white_required'
    OR main_image_strategy <> rule.strategy
    OR position(rule.marker IN source_note) = 0
  );

UPDATE suite_workbench.platform_profiles
SET main_image_background = 'flexible',
    updated_at = now()
WHERE market_scope = 'domestic' AND main_image_background <> 'flexible';
