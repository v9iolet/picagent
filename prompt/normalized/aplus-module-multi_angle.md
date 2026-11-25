---
code: aplus.module.multi_angle
name: "A+详情 · 多角度图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"multi_angle"}'
---

# A+详情 · 多角度图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 多角度图

- 模块目标：在单张图中展示同一商品的多个可确认视角。
- 构图：用同尺度的网格或等距横排呈现正面、侧面、背面、顶部或斜视。优先选 3–4 个原图支持的视角，素材不足时减少视角，统一棚拍光线和阴影。
- 文案：简短模块标题，每个视角配 2–4 字标签，可用细线标注已知部位。
- 合规：不补造原图看不到的接口、按键或结构。未覆盖完整视角时不写全景或 360°。

## User Prompt Template

模块代码：{{moduleCode}}
