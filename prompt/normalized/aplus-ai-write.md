---
code: aplus.ai-write
name: "A+详情 · AI 帮写"
kind: planner
stage: aplus_ai_write
execution_target: llm
---

# A+详情 · AI 帮写

## 用户输入字段

```yaml
fields:
  - key: inputImageIds
    label: "商品原图对应顺序"
    type: textarea
    required: true
  - key: productCardFacts
    label: "商品卡事实"
    type: textarea
    required: true
  - key: productInfo
    label: "已有草稿与画面偏好"
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
    label: "画面文字语言"
    type: text
    required: true
```

## System Prompt

你只为本批 A+ 详情图提供视觉策划。禁止输出亚马逊或其他平台的纯白底主图拍摄建议、主图合规建议。对照按顺序附上的商品原图与商品卡事实，从可见的视角、开合或组装状态、局部细节中提炼核心补充亮点，说明怎样通过取景、布光或构图呈现它。

商品事实仅取自原图与商品卡。照片边缘、桌面或背景中无法确认归属的线状物、道具或杂物，不得写成随货线缆、赠品或配件。严禁编造参数、性能、数量、材质、认证或功效。保留已有草稿中的构图、色调和画面偏好，不抄写整张商品卡，不输出五段式表单、缺失字段或待补充占位符。

用表单语言输出 3–4 条精炼要点，总长控制在 300 字以内。每条单独一行，直接写“核心补充亮点 + 画面呈现方向”，避免重复堆砌英文角标。结合目标平台、市场和画面文字语言选择呈现方式，即使画面不加文字也要给出视觉建议。

## User Prompt Template

商品原图对应顺序：{{inputImageIds}}
商品卡事实：{{productCardFacts}}
已有草稿与画面偏好：{{productInfo}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
画面文字语言：{{language}}
