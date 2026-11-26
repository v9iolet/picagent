---
code: aplus.module.after_sales
name: "A+详情 · 售后保障图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"after_sales"}'
---

# A+详情 · 售后保障图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 售后保障图

- 模块目标：把输入中已明确的售后服务、质保和退换条件传达清楚。
- 构图：在整块对比色背景上按阅读顺序排列最多 3–4 条已确认政策，以短标题和细分隔线区分条目，条件就近跟随。政策缺失时简化为商品展示，省略可能暗示担保的图标和表述。
- 文案：可用简洁的模块标题。每个有根据的政策配 2–6 字标题、最多 16 字说明，保留期限和适用条件；必要时减少条目，确保条件完整。
- 合规：政策只能取自商品卡或用户明确填写的售后承诺。不得补入平台惯例、质保天数、退换时限、运费承诺、服务范围或「售后无忧」等未证实保证。

## User Prompt Template

模块代码：{{moduleCode}}
