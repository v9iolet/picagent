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
- 构图：用商品配环绕卡片、两栏布局或 3–4 格短卡呈现，每条搭配直接相关的细节图或简洁图标，商品和信息互不遮挡。
- 文案：选 3–4 条已确认卖点，事实较少时缩减条数。每条短标题 4–8 字、说明不超过 16 字，可强调已核实的数值和单位。
- 高级 A+ 移动端优先两格。每格只给一条已核实的短标题和一行说明，英文说明最多 8 个词。双端共用文案时也按移动端控制字量。
- 合规：不重复首屏同一句标题，不用图标暗示认证或功能，不虚构容量、续航、功率或功效。

## User Prompt Template

模块代码：{{moduleCode}}
