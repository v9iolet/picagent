-- Replace the platform field limits while preserving configured forbidden words.
UPDATE suite_workbench.platform_profiles AS p
SET listing_copy_rules = (
  p.listing_copy_rules - ARRAY[
    'itemHighlightsMaxLength', 'searchTermsMaxBytes', 'maxTags', 'tagMaxLength',
    'seoTitleMaxLength', 'seoDescriptionMaxLength', 'subtitleMaxLength', 'maxHashtags'
  ]
) || jsonb_build_object(
  'titleMaxLength', r.title_length, 'maxBulletPoints', r.bullets, 'supportsSearchTerms', r.search
) || r.extra_rules
FROM (VALUES
  ('amazon', 75, 5, true, '{"itemHighlightsMaxLength":125,"searchTermsMaxBytes":250}'::jsonb),
  ('etsy', 140, 5, false, '{"maxTags":13,"tagMaxLength":20}'),
  ('shopify', 70, 5, false, '{"seoTitleMaxLength":60,"seoDescriptionMaxLength":160}'),
  ('walmart', 75, 5, false, '{}'),
  ('ebay', 80, 5, false, '{}'),
  ('temu', 80, 5, false, '{}'),
  ('tiktok_shop', 100, 5, false, '{}'),
  ('shopee', 100, 5, false, '{}'),
  ('lazada', 100, 5, false, '{}'),
  ('aliexpress', 100, 5, false, '{}'),
  ('taobao', 30, 3, false, '{"subtitleMaxLength":40}'),
  ('pinduoduo', 30, 3, false, '{"subtitleMaxLength":40}'),
  ('1688', 30, 3, false, '{"subtitleMaxLength":40}'),
  ('jd', 60, 3, false, '{"subtitleMaxLength":40}'),
  ('douyin', 30, 3, false, '{"maxHashtags":10}'),
  ('xiaohongshu', 20, 3, false, '{"maxHashtags":10}')
) AS r(code, title_length, bullets, search, extra_rules)
WHERE p.code = r.code;

CREATE INDEX IF NOT EXISTS listing_copy_suite_history
  ON suite_workbench.listing_copy_jobs (source_suite_id, updated_at DESC, id)
  WHERE status <> 'draft';
