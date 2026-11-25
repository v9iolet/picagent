---
code: aplus.module.series
name: "A+详情 · 系列展示图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"series"}'
---

# A+详情 · 系列展示图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 系列展示图

- 模块目标：在一张图中展示已确认的同款颜色、规格或 SKU。
- 构图：用对齐并排或阶梯式布局突出真实变体。有相应原图时呈现商品外观，只有已确认的名称或颜色资料时用标签、色样说明。
- 文案：短标题，各款下配准确的颜色、规格名或 SKU。没有已确认的变体时，只描述当前商品。
- 合规：不凭空改变商品外观、增加在售款式，不能把参考中的摆件当成同系列商品。

## User Prompt Template

模块代码：{{moduleCode}}
