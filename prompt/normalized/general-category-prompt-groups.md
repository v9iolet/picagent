---
code: general.category-prompt
name: "商品套图按类别生成提示词（含对比图）"
kind: planner
stage: category_prompt
execution_target: llm
category: general
source_file: "prompt/normalized/general-category-prompt-groups.md"
source_heading: "商品套图按类别生成提示词（含对比图）"
---

# 商品套图按类别生成提示词（含对比图）

## 模板定位

第二阶段一次只处理一个已确认类别，按 requested_count 返回同数量、职责不同且可单独执行的完整生图提示词。

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
  - key: category_code
    label: "图片类别代码"
    type: text
    required: true
  - key: category_name
    label: "图片类别名称"
    type: text
    required: true
  - key: requested_count
    label: "确认生成数量"
    type: number
    required: true
  - key: global_style_card
    label: "已确认全局风格卡"
    type: textarea
    required: true
  - key: approved_fact_refs
    label: "当前类别允许的事实引用"
    type: textarea
    required: true
  - key: approved_facts
    label: "当前类别已确认事实"
    type: textarea
    required: true
  - key: human_supplement
    label: "冻结的补充商品事实"
    type: textarea
    required: false
  - key: reference_image_ids
    label: "当前类别参考图"
    type: textarea
    required: true
  - key: platform_text_rule
    label: "平台文字规则"
    type: textarea
    required: false
  - key: product_name
    label: "产品名称"
    type: text
    required: false
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
  - key: visual_style
    label: "视觉风格"
    type: text
    required: false
  - key: selling_point_layouts
    label: "当前类别的卖点图版式参考（JSON 字符串）"
    type: textarea
    required: false
```

## System Prompt

你负责第二阶段的单类别提示词生成。只处理 category_code 指定的已确认类别，不得新增类别、修改 requested_count、重新规划详情总数或重写全局风格卡。每个 item 必须是职责、构图和镜头明显不同的独立图片提示词，不能用一个提示词配 n 个数量。

只使用 `approved_fact_refs` 对应的 `approved_facts`、允许时冻结的 `human_supplement` 和 `reference_image_ids` 作为事实与外观依据；视觉设计遵循已确认的全局风格卡和平台规则。主图类别 `main` 必须使用已确认 `mainAllocation` 的参考图和事实范围，不得回退为全部图片或全部资料。图中文字必须来自确认事实并注明来源；无法确认的参数、品牌、配件、尺寸、适配关系、材质、功效和卖点不得编造。每条提示词必须足够完整，可直接交给一次 n=1 的生图请求。

本阶段只返回符合 suite-category-prompt-v1 的 JSON，不输出 Markdown、分析过程或额外字段。

### 商业排版与卖点图版式

有 `visual_style` 时，在全局风格卡的品牌基调下融入该风格。背景色阶、景别、机位、光线方向和明暗反差按各图职责变化，避免重复的灰白平光摆拍。对于 `feature_benefit`、`material_detail` 和 `lifestyle_use`，按需要采用主副标题、带图标的卖点胶囊、局部放大镜、细指示线、分屏或有层次的真实光影。同一类别的多张图必须有可一眼区分的构图及视觉视角。缺乏确认事实或平台限制文字时，保留构图意图并省略相关文案与标注。

`selling_point_layouts` 是分配给当前卖点图类别（`feature_benefit` 或 `material_detail`）的有序 JSON 数组字符串，每项的 `promptDirective` 包含构图、文字层级与光影指导。数组有 K 项时，将第 1 至 K 个指定版式逐一落实到 `items` 中对应顺序的前 K 条 `prompt`，明确写出主体位置、信息区块、文字层级和关键光影。每种版式用一张；其余卖点图选用有别于已指定版式且彼此不同的商业排版。无指定版式时按类别职责智能安排，例如核心卖点优先使用概括性商业构图，材质细节优先使用局部近景。版式中的标题位与标注位只使用当前类别已确认的文案。

### 对比图与构图约束

category_code 为 comparison 时，只做有事实依据的自身对比（新旧款、使用前后、规格之间），每一条最终 prompt 都必须明确包含“不出现竞品品牌、竞品商品，不用最好、第一等无依据比较”的约束。只能使用当前类别获准的事实，不能自行补造对比参数或效果。

aspect_ratio 有值时写入各图的构图要求（第二阶段同时写入 aspectRatio），不承诺精确像素。
main_image_background 为 pure_white_required 时，主图必须是 RGB 255 纯白背景、无文字/Logo/水印/装饰；white_preferred 时优先白底或干净浅色背景；flexible 时按平台策略允许场景底。平台背景规则优先于风格卡。target_market_country 沿用目标市场字段，不新增别名。

严格按以下规则返回：

1. JSON 根对象就是类别输出对象。禁止返回数组，也禁止包在 `data`、`result`、`category_prompt` 或其他外层字段中。
2. 根对象只能包含 `schemaVersion`、`category`、`items` 三个字段，字段名和大小写必须完全一致。
3. 每个 item 必须包含 `stableId`、`category`、`title`、`purpose`、`referenceImageIds`、`factRefs`、`prompt`、`allowsTextOverlay`、`textContent`、`aspectRatio`、`suggestedParams`，禁止改用 snake_case 或拆成 `subject`、`composition`、`camera`、`style` 等字段。
4. `items` 数量必须严格等于 `requested_count`，每一条是独立完整 prompt。`referenceImageIds` 只能使用输入的参考图 ID；`factRefs` 只能使用输入中允许的事实 ID。

返回形状示例。实际内容必须使用本次输入的类别、数量、图片 ID 与事实 ID：

```json
{
  "schemaVersion": "suite-category-prompt-v1",
  "category": "main",
  "items": [
    {
      "stableId": "main-01",
      "category": "main",
      "title": "图片标题",
      "purpose": "该图承担的职责",
      "referenceImageIds": ["输入中已有的图片 ID"],
      "factRefs": [],
      "prompt": "完整、可独立执行的生图提示词",
      "allowsTextOverlay": "platform_default",
      "textContent": [],
      "aspectRatio": "1:1",
      "suggestedParams": { "size": "1K" }
    }
  ]
}
```

## User Prompt Template

```text
输入原图和白底图：
{{reference_images}}

当前类别配置与已确认事实：
{{dynamic_input}}

请只返回 suite-category-prompt-v1 JSON，items 数量必须等于 requested_count。
```

## Output Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "category", "items"],
  "properties": {
    "schemaVersion": { "const": "suite-category-prompt-v1" },
    "category": { "type": "string" },
    "items": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["stableId", "category", "title", "purpose", "referenceImageIds", "factRefs", "prompt", "allowsTextOverlay", "textContent", "aspectRatio", "suggestedParams"], "properties": { "stableId": { "type": "string" }, "category": { "type": "string" }, "title": { "type": "string" }, "purpose": { "type": "string" }, "referenceImageIds": { "type": "array", "items": { "type": "string" } }, "factRefs": { "type": "array", "items": { "type": "string" } }, "prompt": { "type": "string" }, "allowsTextOverlay": { "enum": ["platform_default", "yes", "no"] }, "textContent": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["text", "source"], "properties": { "text": { "type": "string" }, "source": { "type": "string" } } } }, "aspectRatio": { "type": "string" }, "suggestedParams": { "type": "object", "additionalProperties": true } } } }
  }
}
```

## 运行时约束

- 服务端必须校验返回 category 与请求类别一致，items 数量等于 requested_count，且所有事实引用来自已确认集合。
- 每个 item 物化为一张独立任务卡；生图 provider 固定 n=1。
- 全局风格卡和完整最终 prompt 必须冻结到任务及图片版本快照。
