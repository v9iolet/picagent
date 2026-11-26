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
- 构图：已确认且有对应原图的变体可沿对角线阶梯式陈列，统一尺度与光向，款名依次对齐。只有已确认的名称或颜色资料时，在主商品旁以标签或色样说明。
- 文案：短标题，各款下配准确的颜色、规格名或 SKU。没有已确认的变体时，只描述当前商品。
- 合规：不凭空改变商品外观、增加在售款式，不能把参考中的摆件当成同系列商品。

## User Prompt Template

模块代码：{{moduleCode}}
