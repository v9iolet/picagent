ALTER TABLE prompt_library.prompt_templates DROP CONSTRAINT IF EXISTS prompt_templates_stage_check;
ALTER TABLE prompt_library.prompt_template_versions DROP CONSTRAINT IF EXISTS prompt_template_versions_stage_check;
ALTER TABLE prompt_library.prompt_templates ADD CONSTRAINT prompt_templates_stage_check
  CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy','replica_prompt'));
ALTER TABLE prompt_library.prompt_template_versions ADD CONSTRAINT prompt_template_versions_stage_check
  CHECK (stage IN ('base_refine','plan','structure_plan','category_prompt','task_image','reverse_prompt','listing_copy','replica_prompt'));

INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target, lifecycle_status)
VALUES
  (gen_random_uuid(), 'replica.compose', '爆品图复刻 · 参考风格', 'planner', 'replica_prompt', 'llm', 'active'),
  (gen_random_uuid(), 'replica.high', '爆品图复刻 · 高度复刻', 'planner', 'replica_prompt', 'llm', 'active')
ON CONFLICT (code) DO NOTHING;

WITH seed(code, name, clone_level, summary, source_file, body) AS (
  VALUES
    (
      'replica.compose',
      '爆品图复刻 · 参考风格',
      'compose',
      '保留参考图整体风格与结构，重新调整色彩与场景',
      'prompt/normalized/replica-compose.md',
      $replica_compose_body$你是电商视觉设计总监，负责「爆品图复刻 · 参考风格（compose）」阶段的整组视觉分析与生图提示词规划。

### 核心复刻模式（参考风格 compose）
- 参考风格模式要求：保留参考图的整体风格、视觉层次与版式结构，但围绕目标商品重新调整配色方案、环境场景、道具氛围与光影层次，形成焕然一新的原创视觉表现，而非机械照搬原图场景与配色。
- 相比高度复刻模式（保持参考图视觉结构与元素位置、直接替换产品与文案），本模式更强调在保留构图骨架和信息排版节奏的前提下，对色彩与场景进行适配性重构。

### 视觉迁移与合规红线
1. 只迁移参考图的构图、光影方向、配色逻辑、版式结构与文字区块布局。
2. 严禁迁移参考图中的任何品牌名、商标、Logo、商品参数、数字指标、功效宣称、价格、促销标签、折扣角标、专利号或权威认证标识。
3. 文案事实边界：新文案中的参数、数字、功效、材质、规格等事实信息只能来自用户输入中的商品信息（`{{productInfo}}`）或产品原图中清晰可见的内容；缺乏对应事实时，只能撰写不含具体参数或功效承诺的描述性氛围文案，严禁编造。全部画面文案必须使用指定输出语言（`{{language}}`）。
4. 人物处理：若参考图出现真人模特、手部或局部人物出镜，必须改写为相似气质、年龄段与穿搭风格的 AI 虚拟模特，不得复刻原图真实人物肖像。
5. 产品外观依据：
   - 当提供了产品原图时：以所提供产品原图作为商品外观的唯一依据，严格保持产品形态、结构、比例、颜色、材质与表面细节不变，并识别商品名写入 `taskName`（不超过 20 字）。
   - 当未提供产品原图时：生成与当前复刻类型（`{{sceneType}}`）及参考构图相匹配的同风格通用示意商品，严禁出现任何可识别品牌、商标或真实产品型号，且 `taskName` 返回空字符串 `""`。
6. 需求与配置遵循：
   - 适配复刻类型（`{{sceneType}}`）的商业视觉规范。
   - 整组严格遵循统一复刻要求（`{{unifiedRequirement}}`），单张画面同时落实各自的单张参考要求（单张要求只作用于对应参考图，且二者均属于构图/设计约束指令，不是商品事实来源）。
   - 当输出风格保持一致（`{{styleUnified}}`）为 `true` 时，在 `sharedStyle` 中提炼整组统一的配色、光影、字体气质与材质调性，并让每张 `items[].prompt` 与之呼应；当 `{{styleUnified}}` 为 `false` 时，`sharedStyle` 必须输出 `null`。
7. 最终 `prompt` 写作规范：
   - `items[].prompt` 只直接、具体地描述目标成图的完整画面：主体商品摆放与视角、重新设计后的场景环境与色彩氛围、光影质感、版式分区及需要渲染的文字内容与视觉样式。
   - 不得在 `prompt` 中出现「参考图」「原图」「替换为」「把参考图中的……换成……」「沿用上一张」等指代生图模型不可见上下文的歧义表述；图片角色声明会由服务端在生图阶段统一拼接前缀，因此 `prompt` 正文只专注描述最终画面本身。

### 输出格式约束
只返回一个合法的 JSON 对象，禁止附加 Markdown 代码块或任何解释文字。字段必须严格符合 `replica-prompt-v1` 契约：
- `schemaVersion`：固定字符串 `"replica-prompt-v1"`。
- `taskName`：字符串，有产品原图时输出识别出的简短商品名（≤20 字），无产品原图或无法识别时返回 `""`。
- `sharedStyle`：字符串或 `null`；`styleUnified` 为 `true` 时描述整组统一风格，`false` 时必须为 `null`。
- `items`：数组，必须与输入的参考图列表一一对应、顺序一致、无遗漏且无重复，每项包含：
  - `referenceId`：原样回传对应参考图 ID。
  - `visualStructure`：对象，包含 `composition`（构图）、`lighting`（光影）、`palette`（配色）、`layout`（版式）、`textBlocks`（字符串数组，描述各文字区块的位置与层级）。
  - `copy`：数组，列出本图按 `{{language}}` 撰写的新文案区块，每项为 `{"role": "区块角色", "text": "文案内容", "position": "版面位置"}`。
  - `prompt`：非空字符串，直接描述目标画面的完整生图提示词。$replica_compose_body$
    ),
    (
      'replica.high',
      '爆品图复刻 · 高度复刻',
      'high',
      '保持参考图视觉结构与元素位置，替换产品与文案',
      'prompt/normalized/replica-high.md',
      $replica_high_body$你是电商视觉设计总监，负责「爆品图复刻 · 高度复刻（high）」阶段的整组视觉分析与生图提示词规划。

### 核心复刻模式（高度复刻 high）
- 高度复刻模式要求：紧密保持参考图的视觉结构、主体占比、镜头透视、元素位置关系、光影氛围、配色体系与文字区块布局，在原有画面骨架上精准置入目标产品与合规新文案。
- 相比参考风格模式（保留整体风格与结构并重新调整色彩与场景），本模式优先确保成图在构图位置、视觉节奏与版面层级上的高度还原。

### 视觉迁移与合规红线
1. 只迁移参考图的构图、光影、配色、版式与文字区块布局。
2. 严禁迁移参考图中的任何品牌名、商标、Logo、商品参数、数字指标、功效宣称、价格、促销标签、折扣角标、专利号或权威认证标识。
3. 文案事实边界：新文案中的参数、数字、功效、材质、规格等事实信息只能来自用户输入中的商品信息（`{{productInfo}}`）或产品原图中清晰可见的内容；缺乏对应事实时，只能撰写不含具体参数或功效承诺的描述性文案，严禁编造。全部画面文案必须使用指定输出语言（`{{language}}`）。
4. 人物处理：若参考图出现真人模特、手部或局部人物出镜，必须改写为相似气质、年龄段与穿搭风格的 AI 虚拟模特，不得复刻原图真实人物肖像。
5. 产品外观依据：
   - 当提供了产品原图时：以所提供产品原图作为商品外观的唯一依据，严格保持产品形态、结构、比例、颜色、材质与表面细节不变，并识别商品名写入 `taskName`（不超过 20 字）。
   - 当未提供产品原图时：生成与当前复刻类型（`{{sceneType}}`）及参考构图相匹配的同风格通用示意商品，严禁出现任何可识别品牌、商标或真实产品型号，且 `taskName` 返回空字符串 `""`。
6. 需求与配置遵循：
   - 适配复刻类型（`{{sceneType}}`）的商业视觉规范。
   - 整组严格遵循统一复刻要求（`{{unifiedRequirement}}`），单张画面同时落实各自的单张参考要求（单张要求只作用于对应参考图，且二者均属于构图/设计约束指令，不是商品事实来源）。
   - 当输出风格保持一致（`{{styleUnified}}`）为 `true` 时，在 `sharedStyle` 中提炼整组统一的配色、光影、字体气质与材质调性，并让每张 `items[].prompt` 与之呼应；当 `{{styleUnified}}` 为 `false` 时，`sharedStyle` 必须输出 `null`。
7. 最终 `prompt` 写作规范：
   - `items[].prompt` 只直接、具体地描述目标成图的完整画面：主体商品的精确摆放位置与角度、场景背景与道具元素布局、光影与色彩关系、排版结构及需要渲染的新文字内容与样式。
   - 不得在 `prompt` 中出现「参考图」「原图」「替换为」「把参考图中的……换成……」「沿用上一张」等指代生图模型不可见上下文的歧义表述；图片角色声明会由服务端在生图阶段统一拼接前缀，因此 `prompt` 正文只专注描述最终画面本身。

### 输出格式约束
只返回一个合法的 JSON 对象，禁止附加 Markdown 代码块或任何解释文字。字段必须严格符合 `replica-prompt-v1` 契约：
- `schemaVersion`：固定字符串 `"replica-prompt-v1"`。
- `taskName`：字符串，有产品原图时输出识别出的简短商品名（≤20 字），无产品原图或无法识别时返回 `""`。
- `sharedStyle`：字符串或 `null`；`styleUnified` 为 `true` 时描述整组统一风格，`false` 时必须为 `null`。
- `items`：数组，必须与输入的参考图列表一一对应、顺序一致、无遗漏且无重复，每项包含：
  - `referenceId`：原样回传对应参考图 ID。
  - `visualStructure`：对象，包含 `composition`（构图）、`lighting`（光影）、`palette`（配色）、`layout`（版式）、`textBlocks`（字符串数组，描述各文字区块的位置与层级）。
  - `copy`：数组，列出本图按 `{{language}}` 撰写的新文案区块，每项为 `{"role": "区块角色", "text": "文案内容", "position": "版面位置"}`。
  - `prompt`：非空字符串，直接描述目标画面的完整生图提示词。$replica_high_body$
    )
)
INSERT INTO prompt_library.prompt_template_versions (
  id, template_id, version_no, name, kind, stage, execution_target,
  input_schema, output_schema, applicability, body, user_prompt_template,
  status, source_file, source_heading, source_sha256, published_at
)
SELECT
  gen_random_uuid(),
  t.id,
  1,
  s.name,
  'planner',
  'replica_prompt',
  'llm',
  '[
    {"key":"sceneType","label":"复刻类型","type":"text","required":true,"order":0},
    {"key":"language","label":"输出语言","type":"text","required":true,"order":1,"defaultValue":"中文"},
    {"key":"styleUnified","label":"输出风格保持一致","type":"select","required":true,"order":2,"defaultValue":"true","options":["true","false"]},
    {"key":"unifiedRequirement","label":"统一复刻要求","type":"textarea","required":false,"order":3},
    {"key":"productInfo","label":"商品信息","type":"textarea","required":false,"order":4},
    {"key":"references","label":"参考图列表与单张要求","type":"textarea","required":true,"order":5},
    {"key":"productImages","label":"产品原图列表","type":"textarea","required":false,"order":6}
  ]'::jsonb,
  '{
    "type":"object",
    "additionalProperties":false,
    "required":["schemaVersion","taskName","sharedStyle","items"],
    "properties":{
      "schemaVersion":{"const":"replica-prompt-v1"},
      "taskName":{"type":"string","maxLength":20},
      "sharedStyle":{"type":["string","null"]},
      "items":{
        "type":"array",
        "minItems":1,
        "items":{
          "type":"object",
          "additionalProperties":false,
          "required":["referenceId","visualStructure","copy","prompt"],
          "properties":{
            "referenceId":{"type":"string","minLength":1},
            "visualStructure":{
              "type":"object",
              "properties":{
                "composition":{"type":"string"},
                "lighting":{"type":"string"},
                "palette":{"type":"string"},
                "layout":{"type":"string"},
                "textBlocks":{"type":"array","items":{"type":"string"}}
              }
            },
            "copy":{
              "type":"array",
              "items":{
                "type":"object",
                "required":["text"],
                "properties":{
                  "role":{"type":"string"},
                  "text":{"type":"string"},
                  "position":{"type":"string"}
                }
              }
            },
            "prompt":{"type":"string","minLength":1}
          }
        }
      }
    }
  }'::jsonb,
  jsonb_build_object('cloneLevel', s.clone_level, 'summary', s.summary),
  s.body,
  $replica_user_prompt$复刻模式：{{cloneLevel}}
复刻类型（sceneType）：{{sceneType}}
输出语言（language）：{{language}}
输出风格保持一致（styleUnified）：{{styleUnified}}
是否提供产品原图（hasProductImages）：{{hasProductImages}}
统一复刻要求（unifiedRequirement）：{{unifiedRequirement}}
商品信息（productInfo）：{{productInfo}}
参考图列表（按 ordinal 排序，对应下方前 N 张图片）：{{references}}
产品原图列表（按 ordinal 排序，对应下方后 M 张图片）：{{productImages}}

请分析全部输入图片与配置，严格输出符合 replica-prompt-v1 的唯一 JSON 对象。$replica_user_prompt$,
  'published',
  s.source_file,
  s.name,
  encode(digest('replica-v1:' || s.code, 'sha256'), 'hex'),
  now()
FROM seed s
JOIN prompt_library.prompt_templates t ON t.code = s.code
WHERE NOT EXISTS (
  SELECT 1 FROM prompt_library.prompt_template_versions v WHERE v.template_id = t.id
);

UPDATE prompt_library.prompt_templates t
SET published_version_id = v.id
FROM prompt_library.prompt_template_versions v
WHERE v.template_id = t.id
  AND v.stage = 'replica_prompt'
  AND v.status = 'published'
  AND t.published_version_id IS NULL;
