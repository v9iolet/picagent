-- Startup replays this migration before 041 validates the expanded constraints.
ALTER TABLE prompt_library.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_stage_check;
ALTER TABLE prompt_library.prompt_template_versions DROP CONSTRAINT IF EXISTS prompt_template_versions_stage_check;
ALTER TABLE prompt_library.prompt_templates ADD CONSTRAINT prompt_templates_stage_check
  CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy','replica_prompt','product_onboarding')) NOT VALID;
ALTER TABLE prompt_library.prompt_template_versions ADD CONSTRAINT prompt_template_versions_stage_check
  CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy','replica_prompt','product_onboarding')) NOT VALID;

INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target, lifecycle_status)
VALUES
  (gen_random_uuid(), 'product.onboarding', '首页 · 商品信息建档', 'planner', 'product_onboarding', 'llm', 'active')
ON CONFLICT (code) DO NOTHING;

UPDATE prompt_library.prompt_templates
SET lifecycle_status = 'active'
WHERE code = 'product.onboarding'
  AND lifecycle_status <> 'active';

INSERT INTO prompt_library.prompt_template_versions (
  id, template_id, version_no, name, kind, stage, execution_target,
  input_schema, output_schema, applicability, body, user_prompt_template,
  status, source_file, source_heading, source_sha256, published_at
)
SELECT
  gen_random_uuid(),
  t.id,
  1,
  '首页 · 商品信息建档',
  'planner',
  'product_onboarding',
  'llm',
  '[
    {"key":"currentDraftCard","label":"当前右侧商品信息卡草稿","type":"textarea","required":true,"order":0},
    {"key":"missingRequiredFields","label":"当前缺失必填字段","type":"textarea","required":true,"order":1},
    {"key":"conversationHistory","label":"历史对话记录","type":"textarea","required":false,"order":2},
    {"key":"latestUserMessage","label":"本轮用户消息","type":"textarea","required":false,"order":3},
    {"key":"txtAttachments","label":"本轮上传的 .txt 附件内容","type":"textarea","required":false,"order":4},
    {"key":"supplierImages","label":"当前会话供应商参考图列表","type":"textarea","required":false,"order":5}
  ]'::jsonb,
  '{
    "type":"object",
    "additionalProperties":false,
    "required":["schemaVersion","reply","draftCard","missingRequiredFields"],
    "properties":{
      "schemaVersion":{"const":"product-onboarding-v1"},
      "reply":{"type":"string","minLength":1},
      "draftCard":{
        "type":"object",
        "additionalProperties":false,
        "required":[
          "name",
          "sellingPoints",
          "specifications",
          "materialsCraft",
          "audienceScenarios",
          "packageContents",
          "painPointsComparison",
          "usageDemoHighlights",
          "certificationsProhibitions"
        ],
        "properties":{
          "name":{"type":"string","maxLength":120},
          "sellingPoints":{
            "type":"array",
            "maxItems":10,
            "items":{"type":"string","maxLength":200}
          },
          "specifications":{"type":"string","maxLength":1000},
          "materialsCraft":{"type":"string","maxLength":800},
          "audienceScenarios":{"type":"string","maxLength":800},
          "packageContents":{"type":"string","maxLength":600},
          "painPointsComparison":{"type":"string","maxLength":1000},
          "usageDemoHighlights":{"type":"string","maxLength":1000},
          "certificationsProhibitions":{"type":"string","maxLength":800}
        }
      },
      "missingRequiredFields":{
        "type":"array",
        "items":{
          "type":"string",
          "enum":[
            "name",
            "sellingPoints",
            "specifications",
            "materialsCraft",
            "audienceScenarios",
            "packageContents"
          ]
        }
      }
    }
  }'::jsonb,
  '{"summary":"首页多轮对话抽取结构化商品信息卡，合并追问缺失必填项"}'::jsonb,
  $product_onboarding_body$你是电商商品建档专家，负责「首页 · 商品信息建档（`product-onboarding-v1`）」阶段的多轮商品事实抽取、结构化归档与缺失项追问。

### 商品信息卡字段定义（6 项入库必填 + 3 项选填）
#### 6 项入库必填
1. `name`（商品名称）：1–120 字，准确概括产品名称、核心形态或关键规格。
2. `sellingPoints`（核心卖点）：1–10 条字符串数组，每条 1–200 字，提炼客观、具体的产品核心卖点。
3. `specifications`（规格参数与尺寸重量）：1–1000 字，记录容量、功率、尺寸、重量、型号规格等客观数值。
4. `materialsCraft`（材质与工艺细节）：1–800 字，记录主体材质、表面工艺、结构做工等事实细节。
5. `audienceScenarios`（适用人群与使用场景）：1–800 字，记录目标使用人群与典型使用场景。
6. `packageContents`（包装清单 / 配件说明）：1–600 字，记录包装内全部物件与配件数量。

#### 3 项选填字段
7. `painPointsComparison`（用户痛点与自身对比数据）：0–1000 字，仅允许新旧款/使用前后/规格间客观对比，严禁编造或引入竞品对比。
8. `usageDemoHighlights`（使用方法 / 动态演示亮点）：0–1000 字，记录操作步骤、演示亮点或养护要点。
9. `certificationsProhibitions`（认证资质与宣传禁忌）：0–800 字，记录 FCC/CE/FDA 等已提供认证及明确禁语/不可承诺功效。

### 严格事实边界与反编造红线
1. 只提取用户对话文本、`.txt` 纯文本附件与供应商参考图中清晰可见的客观商品事实，**严禁编造、推断或补全任何未提供的参数、尺寸、容量、重量、材质、工艺、认证资质或配件清单**。
2. 供应商参考图仅用于核对与提取肉眼清晰可见的外观结构、材质特征或包装文字，不得臆测图中不可见的数值或认证。
3. 尚未获得依据的字段必须留空（字符串返回 `""`，`sellingPoints` 返回 `[]`），严禁填入「暂无」「待定」「未知」「未提供」「N/A」等占位文本。
4. 单品无额外配件规范化：当用户明确表示该商品为单品且无额外配件/赠品（如「没有配件」「只有本体」「无赠品配件」「单件无配件」等），必须将 `packageContents` 规范填写为：`单品本体 ×1，无额外配件`。

### 草稿合并与手动修改保留规则
1. 以 `{{currentDraftCard}}` 作为本轮合并基准，完整保留用户此前已确认或在右侧表单手动修改过的非空字段。
2. 只有当本轮 `{{latestUserMessage}}` 或 `{{txtAttachments}}` 明确补充或更正某字段时，才更新该字段；不得无故覆盖、删减或改写用户已有非空字段。

### 合并追问规则（核心要求）
1. 完成 `draftCard` 合并后，逐项核对全部 6 项入库必填字段（`name`、`sellingPoints`、`specifications`、`materialsCraft`、`audienceScenarios`、`packageContents`），将仍为空的字段键名按顺序写入 `missingRequiredFields`。
2. **若仍有任意缺失必填项**：必须在单条 `reply` 中先简要确认本轮已提取到的信息，随后**按编号（1. 2. 3. ...）一次性合并追问全部剩余缺失必填项**，并给出简洁的填写示例；**严禁逐轮挤牙膏式每次只问 1 个字段**。
3. **若 6 项必填字段已全部齐备（`missingRequiredFields` 为空数组 `[]`）**：在 `reply` 中明确告知核心建档信息已完备，引导用户核对右侧「商品信息卡」表单（可按需补充选填项或供应商参考图）后点击「保存到商品库」。

### 输出格式约束
只返回一个合法的 JSON 对象，禁止附加 Markdown 代码块或任何解释文字。字段必须严格符合 `product-onboarding-v1` 契约：
- `schemaVersion`：固定字符串 `"product-onboarding-v1"`。
- `reply`：非空字符串，面向产品开发的中文回复与合并追问文本。
- `draftCard`：对象，必须包含全部 9 个字段（`name`、`sellingPoints`、`specifications`、`materialsCraft`、`audienceScenarios`、`packageContents`、`painPointsComparison`、`usageDemoHighlights`、`certificationsProhibitions`）。
- `missingRequiredFields`：字符串数组，仅包含仍缺失的必填字段键名（6 项均齐备时为 `[]`）。$product_onboarding_body$,
  $product_onboarding_user_prompt$当前右侧商品信息卡草稿（currentDraftCard）：{{currentDraftCard}}
当前缺失必填字段（missingRequiredFields）：{{missingRequiredFields}}
历史对话记录（conversationHistory）：{{conversationHistory}}
本轮用户消息（latestUserMessage）：{{latestUserMessage}}
本轮上传的 .txt 附件内容（txtAttachments）：{{txtAttachments}}
当前会话供应商参考图列表（按 ordinal 排序，对应下方图片）：{{supplierImages}}

请严格基于上述文本、.txt 附件与供应商参考图中的客观事实，合并更新商品信息卡草稿，并严格输出符合 product-onboarding-v1 的唯一 JSON 对象。$product_onboarding_user_prompt$,
  'published',
  'prompt/normalized/product-onboarding.md',
  '首页 · 商品信息建档',
  '53ac5b8a9dc7dfc1e0386dc1f0a9db8e0cca6ee1a99e373e15c13a540ac9dd1d',
  now()
FROM prompt_library.prompt_templates t
WHERE t.code = 'product.onboarding'
  AND NOT EXISTS (
    SELECT 1 FROM prompt_library.prompt_template_versions v WHERE v.template_id = t.id
  );

UPDATE prompt_library.prompt_templates t
SET published_version_id = v.id
FROM prompt_library.prompt_template_versions v
WHERE v.template_id = t.id
  AND t.code = 'product.onboarding'
  AND v.stage = 'product_onboarding'
  AND v.status = 'published'
  AND t.published_version_id IS NULL;
