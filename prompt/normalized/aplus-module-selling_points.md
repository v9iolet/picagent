---
code: aplus.module.selling_points
name: "A+详情 · 核心卖点图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"selling_points"}'
---

# A+详情 · 核心卖点图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 核心卖点图

- 模块目标：帮助浏览者快速理解可靠的商品差异和使用价值。
- 构图：商品以斜角或立体姿态占画面 40–50%，在轮廓外放高对比图标胶囊，以细引线指向对应部位；也可用左右撞色分栏，一侧保留大主体，另一侧纵向排卖点。避免 2×2 浅灰圆角框，不遮挡商品。
- 文案：选 3–4 条已确认卖点，事实较少时缩减条数。每条短标题 4–8 字、说明不超过 16 字，可强调已核实的数值和单位。
- 高级 A+ 移动端优先两条卖点。每条只给一条已核实的短标题和一行说明，英文说明最多 8 个词。双端共用文案时也按移动端控制字量。
- 合规：不重复首屏同一句标题，不用图标暗示认证或功能，不虚构容量、续航、功率或功效。

## User Prompt Template

模块代码：{{moduleCode}}
