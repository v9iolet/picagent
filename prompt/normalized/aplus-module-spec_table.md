---
code: aplus.module.spec_table
name: "A+详情 · 详细规格/参数表"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"spec_table"}'
---

# A+详情 · 详细规格/参数表

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 详细规格/参数表

- 模块目标：按条传递已确认的商品规格，方便快速查找和核对。
- 构图：用简洁商品图和两列表格，按画幅左右或上下分区，统一行距和对齐，给文字留出足够空间。
- 文案：短标题及最多 8 行「参数名：参数值」。参数齐全时优先选最相关的 5–8 行，保留原单位，无值的行省略。
- 合规：不根据品类补猜参数，不添加空行、虚构认证或规格，也不把待补充占位画出来。

## User Prompt Template

模块代码：{{moduleCode}}
