---
code: aplus.module.craftsmanship
name: "A+详情 · 工艺制作图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"craftsmanship"}'
---

# A+详情 · 工艺制作图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 工艺制作图

- 模块目标：把有资料支撑的选材、加工或制作过程讲清楚。
- 构图：将已有证据的工艺环节做成时间轴或 3–4 格流程图，保持每格构图统一。输入只支持成品细节时，集中展示有依据的材质与细节。
- 文案：短标题，每个已确认环节配 2–6 字步骤名及不超过 16 字的说明。
- 合规：不能用行业通用流程替代本商品的事实，不假造工厂、质检流程、资质或特殊工艺。

## User Prompt Template

模块代码：{{moduleCode}}
