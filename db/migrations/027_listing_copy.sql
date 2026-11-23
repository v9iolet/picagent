ALTER TABLE suite_workbench.platform_profiles ADD COLUMN IF NOT EXISTS listing_copy_rules jsonb;
ALTER TABLE suite_workbench.platform_profiles ALTER COLUMN listing_copy_rules SET DEFAULT '{"titleMaxLength":60,"maxBulletPoints":3,"supportsSearchTerms":false,"forbiddenWords":["最好","全网第一","100% guaranteed"]}';
-- 工作台保守生成预算，可按站点/类目调整；不是各市场完整政策。
-- Amazon 非媒体商品：Seller Central 2026-06-10 公告（7 月 27 日起 75 字符）。
UPDATE suite_workbench.platform_profiles AS p SET listing_copy_rules = jsonb_build_object(
 'titleMaxLength', r.title_length, 'maxBulletPoints', r.bullets, 'supportsSearchTerms', r.search,
 'forbiddenWords', CASE WHEN p.market_scope = 'domestic' THEN '["全网第一","国家级","绝对有效"]'::jsonb ELSE '["best seller","100% guaranteed","free shipping"]'::jsonb END
) FROM (VALUES
 ('amazon',75,5,true), ('walmart',75,5,false), ('tiktok_shop',80,5,false), ('ebay',80,5,false),
 ('etsy',120,5,true), ('shopee',100,5,false), ('lazada',100,5,false), ('aliexpress',100,5,false),
 ('temu',80,5,false), ('shopify',70,5,false), ('taobao',30,3,false), ('jd',30,3,false),
 ('pinduoduo',30,3,false), ('1688',30,3,false), ('douyin',30,3,false), ('xiaohongshu',20,3,false)
) AS r(code,title_length,bullets,search) WHERE p.code = r.code AND p.listing_copy_rules IS NULL;
UPDATE suite_workbench.platform_profiles SET listing_copy_rules=DEFAULT WHERE listing_copy_rules IS NULL;
ALTER TABLE suite_workbench.platform_profiles ALTER COLUMN listing_copy_rules SET NOT NULL;

ALTER TABLE prompt_library.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_stage_check;
ALTER TABLE prompt_library.prompt_template_versions DROP CONSTRAINT IF EXISTS prompt_template_versions_stage_check;
ALTER TABLE prompt_library.prompt_templates ADD CONSTRAINT prompt_templates_stage_check
 CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy')) NOT VALID;
ALTER TABLE prompt_library.prompt_template_versions ADD CONSTRAINT prompt_template_versions_stage_check
 CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy')) NOT VALID;

CREATE TABLE IF NOT EXISTS suite_workbench.listing_copy_jobs (
 id uuid PRIMARY KEY, source_suite_id uuid REFERENCES suite_workbench.suites(id) ON DELETE SET NULL,
 platform text NOT NULL, target_market text NOT NULL, output_language text NOT NULL, input_json jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('draft','running','failed','succeeded')), error_code text,
 revision integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_copy_history ON suite_workbench.listing_copy_jobs (updated_at DESC,id) WHERE status <> 'draft';
CREATE TABLE IF NOT EXISTS suite_workbench.listing_copy_versions (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES suite_workbench.listing_copy_jobs(id) ON DELETE CASCADE,
 version_number integer NOT NULL, content_json jsonb NOT NULL, prompt_snapshot_json jsonb NOT NULL,
 created_at timestamptz NOT NULL, UNIQUE(job_id,version_number)
);
CREATE TABLE IF NOT EXISTS suite_workbench.listing_copy_input_images (
 id uuid NOT NULL, job_id uuid NOT NULL REFERENCES suite_workbench.listing_copy_jobs(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6), original_object_key text NOT NULL, thumbnail_object_key text NOT NULL,
 mime_type text NOT NULL, width integer NOT NULL, height integer NOT NULL, sha256 text NOT NULL, original_filename text NOT NULL,
 PRIMARY KEY(job_id,id), UNIQUE(job_id,ordinal)
);
