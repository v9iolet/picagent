ALTER TABLE suite_workbench.platform_profiles
  ADD COLUMN IF NOT EXISTS main_image_background text NOT NULL DEFAULT 'flexible'
  CHECK (main_image_background IN ('pure_white_required', 'white_preferred', 'flexible'));

UPDATE suite_workbench.platform_profiles AS profile
SET main_image_background = rules.background,
    main_image_strategy = CASE
      WHEN rules.background = 'pure_white_required'
        THEN '主图必须使用纯白背景（RGB 255,255,255），商品主体完整清晰；不添加文字、Logo、水印、边框或无关装饰。'
      ELSE profile.main_image_strategy
    END,
    source_note = CASE
      WHEN position('[主图背景规范 v1]' IN profile.source_note) > 0 THEN profile.source_note
      ELSE concat_ws(' ', NULLIF(profile.source_note, ''), '[主图背景规范 v1] ' || CASE profile.code
        WHEN 'amazon' THEN '依据 Amazon 商品图片主图纯白背景要求；主图必须为 RGB 255,255,255，具体站点与类目最新规则需持续复核。'
        WHEN 'walmart' THEN '依据 Walmart Marketplace 商品图片主图纯白背景要求；主图必须为 RGB 255,255,255，替代原“需要时优先白底”策略，具体站点与类目最新规则需持续复核。'
        WHEN 'tiktok_shop' THEN '依据 TikTok Shop 商品图片主图纯白背景要求；主图必须为 RGB 255,255,255，具体站点与类目最新规则需持续复核。'
        ELSE '依据 db/migrations/009_platform_profiles.sql 现有主图策略归类；具体站点与类目最新规则需持续复核。'
      END)
    END,
    updated_at = now()
FROM (VALUES
  ('amazon', 'pure_white_required'),
  ('walmart', 'pure_white_required'),
  ('tiktok_shop', 'pure_white_required'),
  ('jd', 'white_preferred'),
  ('shopee', 'white_preferred'),
  ('lazada', 'white_preferred'),
  ('aliexpress', 'white_preferred'),
  ('temu', 'white_preferred'),
  ('taobao', 'flexible'),
  ('pinduoduo', 'flexible'),
  ('douyin', 'flexible'),
  ('xiaohongshu', 'flexible'),
  ('1688', 'flexible'),
  ('ebay', 'flexible'),
  ('etsy', 'flexible'),
  ('shopify', 'flexible')
) AS rules(code, background)
WHERE profile.code = rules.code;
