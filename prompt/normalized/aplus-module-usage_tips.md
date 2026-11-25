---
code: aplus.module.usage_tips
name: "A+详情 · 使用建议图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"usage_tips"}'
---

# A+详情 · 使用建议图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 使用建议图

- 模块目标：让浏览者看懂商品的使用方法与已有提示。
- 构图：用一张图中的步骤卡片或 2×2 格表现实际操作，每格集中展示一个动作，按原图参照商品结构和手部接触位置。
- 文案：约 3–4 步或注意事项，每项标题 2–8 字，说明不超过 18 字，步骤按真实顺序。已确认内容不足时减少条数。
- 合规：只写有依据且安全的操作和维护事项，不编造警示、工作温度或未经确认的操作步骤。

## User Prompt Template

模块代码：{{moduleCode}}
