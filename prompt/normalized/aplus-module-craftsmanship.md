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
- 构图：将有依据且可画出的工艺步骤做成时间轴或 3–4 格流程图。只有成品原图时，用完整商品配一到两处可确认的外观细节，省去工序编号、剖面和内部示意，不凭外观命名材料。
- 文案：短标题，每个已确认环节配 2–6 字步骤名及不超过 16 字的说明。
- 合规：不能用行业通用流程替代本商品的事实，不假造工厂、质检流程、资质或特殊工艺。

## User Prompt Template

模块代码：{{moduleCode}}
