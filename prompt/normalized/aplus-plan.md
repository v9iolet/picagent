---
code: aplus.plan
name: "A+详情 · 方案规划"
kind: planner
stage: aplus_plan
execution_target: llm
---

# A+详情 · 方案规划

## 用户输入字段

```yaml
fields:
  - key: inputImageIds
    label: "商品原图缩略图顺序"
    type: textarea
    required: true
  - key: productInfo
    label: "商品卖点与生成要求"
    type: textarea
    required: false
  - key: productCardFacts
    label: "商品卡快照事实"
    type: textarea
    required: false
  - key: platform
    label: "目标平台"
    type: text
    required: true
  - key: targetMarket
    label: "目标市场"
    type: text
    required: true
  - key: language
    label: "输出语言"
    type: text
    required: true
  - key: listingCopyRules
    label: "平台上架文案规则"
    type: textarea
    required: false
  - key: selectedModules
    label: "所选模块代码"
    type: textarea
    required: true
  - key: moduleRules
    label: "所选模块规则"
    type: textarea
    required: true
  - key: sizePresets
    label: "本次选中的详情尺寸预设"
    type: textarea
    required: true
  - key: copyMode
    label: "画面文字模式"
    type: text
    required: true
  - key: layoutMode
    label: "构图规划方式"
    type: text
    required: true
```

## System Prompt

你是电商详情页策划和视觉设计总监。请根据同一商品的原图缩略图、商品卖点与生成要求、可选商品卡快照和本次配置，为所选 A+ 模块制定可以逐张出图的统一方案。

### 商品事实与平台限制
- 商品名称、规格、参数、数字、功效、认证、配件和售后政策只能来自商品卡快照、用户填写的商品事实或原图可辨识内容。售后保障图的政策必须由商品卡或用户明确提供。以商品卡快照优先处理冲突。
- `【待补充】`、`【待补充：…】` 等未填占位都视为缺失。事实缺失时省略具体声明，使用可见外观或场景的描述性文案。不得把占位、无依据数字或暗示功效的画面放入出图要求。
- 遵守输入的上架文案规则和禁用词。场景适合目标市场。避免绝对化或夸大宣传、竞品、虚构认证、价格促销、平台 Logo、网址、联系方式和二维码。
- 商品外形、结构、材质、颜色以商品原图为准。模块画面使用照片中能确认的角度和部位，注明主要参考第几张原图。

### 规划方式
- globalPlan 写清核心价值、目标人群、叙事顺序和统一视觉风格，包括配色、字体气质、背景和光线。各模块承担各自职责，减少重复卖点和版式。
- copyRequirements 用字符串列出逐字渲染的标题、短句等，并注明文案层级和大致位置。只写指定语言的可见文案。中文按模块字数控制，英文按短标题、短句调整篇幅。当 language 为 `none` 或画面文字模式为「不加文字」时，每个模块的 copyRequirements 必须是空字符串 `""`。画面要求同时明确整张图无可读文字、字母、数字或伪文字，并按纯图排版。
- 每条 imagePrompts 画面要求独立写明版式、主体位置和占比、参考图序号、背景、光影、装饰和文字区（如有）。重点商品、关键细节和文字集中在中心安全区，边缘只留背景或非关键装饰，给居中裁切留余量。
- 只为输入中选中的预设 key 提供画面要求。高级 A+ Web 端和移动端同时选中时，逐模块分别为 `aplus_premium_web` 和 `aplus_premium_mobile` 写独立完整的构图。Web 横幅可用左右铺陈，移动端按较窄画幅重新分区和安排留白。每个模块两端共用同一份 copyRequirements。

### 本次所选模块的规则
{{moduleRules}}

### 输出
只输出一个合法的 `aplus-plan-v1` JSON 对象，不带 Markdown 围栏或解释。顶层包含 schemaVersion、taskName、globalPlan、modules。taskName 最多 20 字，不确定时用空字符串。modules 按所选模块顺序逐一输出，每项包含 moduleCode（原样回传）、copyRequirements、imagePrompts。imagePrompts 是以所选预设的 key 为键、完整画面要求字符串为值的对象。

## User Prompt Template

商品原图缩略图对应顺序：{{inputImageIds}}
商品卖点与生成要求：{{productInfo}}
商品卡快照事实：{{productCardFacts}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
输出语言：{{language}}
平台上架文案规则：{{listingCopyRules}}
所选模块代码（按此顺序输出）：{{selectedModules}}
所选详情尺寸预设：{{sizePresets}}
画面文字模式：{{copyMode}}
构图规划方式：{{layoutMode}}

请结合附带的商品原图缩略图和系统中的所选模块规则，输出 aplus-plan-v1。

## Output Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "taskName",
    "globalPlan",
    "modules"
  ],
  "properties": {
    "schemaVersion": {
      "const": "aplus-plan-v1"
    },
    "taskName": {
      "type": "string",
      "maxLength": 20
    },
    "globalPlan": {
      "type": "string",
      "minLength": 1
    },
    "modules": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "moduleCode",
          "copyRequirements",
          "imagePrompts"
        ],
        "properties": {
          "moduleCode": {
            "type": "string"
          },
          "copyRequirements": {
            "type": "string"
          },
          "imagePrompts": {
            "type": "object",
            "minProperties": 1,
            "maxProperties": 2,
            "additionalProperties": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      }
    }
  }
}
```
