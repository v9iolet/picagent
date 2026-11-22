WITH rule(strategy, marker) AS (
  VALUES (
    '首图/主图不添加文字、Logo、水印或装饰；卖点图与细节副图允许并鼓励使用清晰、克制、有事实依据的商业卖点标题、图标与标注。',
    '[副图卖点文字规范 v1]'
  )
)
UPDATE suite_workbench.platform_profiles
SET text_strategy = rule.strategy,
    source_note = CASE
      WHEN position(rule.marker IN source_note) > 0 THEN source_note
      ELSE concat_ws(' ', NULLIF(source_note, ''), rule.marker)
    END,
    updated_at = now()
FROM rule
WHERE code IN ('ebay', 'tiktok_shop')
  AND (
    text_strategy <> rule.strategy
    OR position(rule.marker IN source_note) = 0
  );
