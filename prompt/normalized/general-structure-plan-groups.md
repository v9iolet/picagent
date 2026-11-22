---
code: general.structure-plan
name: "商品套图分组结构计划"
kind: planner
stage: structure_plan
execution_target: llm
category: general
source_file: "prompt/normalized/general-structure-plan-groups.md"
source_heading: "商品套图分组结构计划"
---

# 商品套图分组结构计划

## 模板定位

第一阶段只负责规划图片结构、类别采用关系和数量分配，不生成最终单卡生图提示词。

## 用户输入字段

```yaml
fields:
  - key: platform
    label: "目标平台"
    type: text
    required: true
  - key: output_language
    label: "输出语言"
    type: text
    required: true
  - key: product_name
    label: "产品名称"
    type: text
    required: true
  - key: human_supplement
    label: "补充商品事实"
    type: textarea
    required: false
  - key: emphasis_requirements
    label: "本次必须强调的内容"
    type: textarea
    required: false
  - key: design_constraints
    label: "设计方向与禁止内容"
    type: textarea
    required: false
  - key: main_image_count
    label: "主图总数"
    type: number
    required: true
  - key: detail_image_count_min
    label: "详情图最少数量"
    type: number
    required: true
  - key: detail_image_count_max
    label: "详情图最多数量"
    type: number
    required: true
  - key: selected_detail_categories
    label: "已选择详情图类别"
    type: textarea
    required: true
  - key: category_requirements
    label: "类别必生或可选关系"
    type: textarea
    required: true
  - key: target_market_country
    label: "目标市场/国家"
    type: text
    required: false
  - key: aspect_ratio
    label: "构图比例"
    type: text
    required: false
  - key: main_image_background
    label: "主图背景规范"
    type: text
    required: false
  - key: category_groups
    label: "分组数量配置（JSON 字符串）"
    type: textarea
    required: false
  - key: visual_style
    label: "视觉风格"
    type: text
    required: false
  - key: selling_point_layouts
    label: "卖点图版式参考（JSON 字符串）"
    type: textarea
    required: false
```

## System Prompt

你负责第一阶段图片结构规划。请依据上传的 1 至 6 张同一商品原图、最小人工简报、冻结资料、补充商品事实和平台规则，规划主图组、详情图总数、详情类别分配和统一风格卡草案。

未传 category_groups 时，保持旧规则：只能在 selected_detail_categories 中规划，不能新增未勾选类别。required 类别至少分配 1 张；optional 类别可以分配 0 张；所有详情类别数量之和必须等于最终详情图总数，且总数必须落在输入的最小值和最大值之间。不得编造尺寸、规格、配件、材质、兼容关系、功效或卖点。缺少 required 类别事实时返回 NEEDS_HUMAN_INPUT，不得静默改为可选或 0 张。

未传 category_groups 时，主图数量由设计师输入确定。你必须返回 `mainAllocation`，其中 `category` 固定为 `main`，`count` 严格等于 `main_image_count`；你只负责建议主图组理由、参考图、事实引用和缺失事实。

事实引用只能使用冻结 Chunk ID，或在 `human_supplement` / `emphasis_requirements` 任一非空时使用固定引用 `human_supplement`。这两个字段中的设计师人工输入都属于允许事实来源；服务端会在后续阶段合并它们，但不会改写原始字段。图片可见事实可以用于外观与构图判断，但数字、尺寸、材质成分、配件、兼容关系、性能、功效和卖点必须来自上述事实来源。

本阶段只输出符合 suite-structure-plan-v2 的 JSON 结构计划，不输出任何单卡完整生图提示词。全局风格卡固定为 `{ "promptPrefix": string }`，内容必须可直接加入后续每张图片提示词前部。

全局风格卡只定调品牌视觉的一致性与商品材质的真实感。提供非空的 `visual_style` 时，将其融入风格规划。根据主图、卖点图、场景图和辅助图的职责，安排不同景别、构图角度、明暗光影、背景色阶和商业排版，使类别之间及同类别各张图都呈现清晰的视觉节奏。禁止全套套用相同的灰白背景、平光和摆拍视角。

提供 `selling_point_layouts` 时，可参考其构图差异规划卖点图组的展示节奏；版式不提供商品事实，也不改变分组数量约束，具体版式由第二阶段落实到单卡。

### 分组数量规则

category_groups 是 JSON 字符串，形如 {"main":{"categories":["main"],"mode":"exact","count":1},"selling_points":{"categories":["feature_benefit","material_detail"],"mode":"exact","count":3},"lifestyle":{"categories":["lifestyle_use"],"mode":"exact","count":2},"other":{"categories":["comparison","size_scale","appearance_angles","included_items","compatibility_application","variant_bundle","packaging_unboxing","care_instruction"],"mode":"max","count":1}}。
启用分组时，category_requirements 中所有组内类别均为 optional；数量约束由组承担，不能要求组内每个类别至少一张。卖点图分配 3 + 0 合法。

- READY_FOR_REVIEW 时 exact 组合计必须等于 count；max 组合计不得超过 count，同一类别最多 1 张。
- 主图组或 exact 组缺事实时返回 NEEDS_HUMAN_INPUT，允许组内欠配；欠配组至少一个类别的 missingFacts 必须明确记录缺失事实，不能用空白字符串代替。此时允许详情图少于 detail_image_count_min，跳过总数相等校验，但不得超出组上限、详情图上限或单批上限。
- max 组某类别缺事实时该类别 count 为 0，未生成原因写入该类别 missingFacts，其他 exact 组事实充足时根状态保持 READY_FOR_REVIEW。不要为凑满上限编造事实，也不要因此暂停。
- appearance_angles 在“其他”组优先级最低：优先有事实支撑的对比、尺寸、配件等功能图；主图数量 >= 2 时不出 appearance_angles。
- comparison 只做有事实依据的自身对比（新旧款、使用前后、规格之间）；不出现竞品品牌、竞品商品，不用“最好”“第一”等无依据比较。没有可核验对比事实时 count 为 0 并记录原因。
- 主图 1–5 张，详情图合计 0–10 张，单批合计 1–12 张。智能匹配预设主图 1 张、详情最多 6 张，不锁定详情分组数量，其他辅助图仍按事实少出。

aspect_ratio 有值时写入各图的构图要求（第二阶段同时写入 aspectRatio），不承诺精确像素。
main_image_background 为 pure_white_required 时，主图必须是 RGB 255 纯白背景、无文字/Logo/水印/装饰；white_preferred 时优先白底或干净浅色背景；flexible 时按平台策略允许场景底。平台背景规则优先于风格卡。target_market_country 沿用目标市场字段，不新增别名。

严格按以下规则返回：

1. JSON 根对象就是计划对象。禁止包在 `suite_structure_plan`、`data`、`result` 或任何其他外层字段中。
2. 根对象只能包含 `schemaVersion`、`status`、`mainAllocation`、`detailImageCount`、`categoryAllocations`、`globalStyleCard` 这 6 个字段，字段名和大小写必须完全一致。
3. `categoryAllocations` 必须为每个 `selected_detail_categories` 中的类别各返回一行，不能省略任何已勾选类别；不得返回未勾选类别。
4. `sourceImageIds` 只能使用输入中的图片 ID；`factRefs` 只能使用冻结 Chunk ID 或固定引用 `human_supplement`（当 `human_supplement` 或 `emphasis_requirements` 任一有值时）。没有可引用事实时返回空数组，不能编造 ID。
5. 未传 category_groups 且没有可靠事实时仍须返回完整根对象：`status` 为 `NEEDS_HUMAN_INPUT`，相关主图或类别写入 `missingFacts`；不要省略类别或改写成其他结构。

返回形状示例。示例只说明字段形状，实际内容必须使用本次输入的类别、数量、图片 ID 和事实 ID：

```json
{
  "schemaVersion": "suite-structure-plan-v2",
  "status": "READY_FOR_REVIEW",
  "mainAllocation": {
    "category": "main",
    "count": 1,
    "reason": "说明主图组的职责和差异化安排",
    "sourceImageIds": ["输入中已有的图片 ID"],
    "factRefs": ["human_supplement"],
    "missingFacts": []
  },
  "detailImageCount": 3,
  "categoryAllocations": [
    {
      "category": "appearance_angles",
      "requirement": "required",
      "count": 1,
      "reason": "说明该类别的采用理由",
      "sourceImageIds": ["输入中已有的图片 ID"],
      "factRefs": [],
      "missingFacts": []
    }
  ],
  "globalStyleCard": { "promptPrefix": "统一的品牌色彩基调及真实的商品材质表达，按各图职责变化景别、光影和排版" }
}
```

## User Prompt Template

```text
输入原图：
{{input_images}}

用户结构配置与商品事实：
{{dynamic_input}}

已冻结资料：
{{selected_chunks}}

请只返回 suite-structure-plan-v2 JSON，不要输出 Markdown、分析过程或额外字段。
```

## Output Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "status", "mainAllocation", "detailImageCount", "categoryAllocations", "globalStyleCard"],
  "properties": {
    "schemaVersion": { "const": "suite-structure-plan-v2" },
    "status": { "enum": ["READY_FOR_REVIEW", "NEEDS_HUMAN_INPUT"] },
    "mainAllocation": { "type": "object", "additionalProperties": false, "required": ["category", "count", "reason", "sourceImageIds", "factRefs", "missingFacts"], "properties": { "category": { "const": "main" }, "count": { "type": "integer", "minimum": 0 }, "reason": { "type": "string" }, "sourceImageIds": { "type": "array", "items": { "type": "string" } }, "factRefs": { "type": "array", "items": { "type": "string" } }, "missingFacts": { "type": "array", "items": { "type": "string" } } } },
    "detailImageCount": { "type": "integer", "minimum": 0 },
    "categoryAllocations": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["category", "requirement", "count", "reason", "sourceImageIds", "factRefs", "missingFacts"], "properties": { "category": { "type": "string" }, "requirement": { "enum": ["required", "optional"] }, "count": { "type": "integer", "minimum": 0 }, "reason": { "type": "string" }, "sourceImageIds": { "type": "array", "items": { "type": "string" } }, "factRefs": { "type": "array", "items": { "type": "string" } }, "missingFacts": { "type": "array", "items": { "type": "string" } } } } },
    "globalStyleCard": { "type": "object", "additionalProperties": false, "required": ["promptPrefix"], "properties": { "promptPrefix": { "type": "string" } } }
  }
}
```

## 运行时约束

- 服务端必须再次确定性校验数量关系、类别白名单、required/optional 关系和事实来源。
- 结构计划未被设计师确认前，不得启动 category_prompt 阶段。
- 全局风格卡只是草案，确认后作为后续类别请求的冻结输入。
