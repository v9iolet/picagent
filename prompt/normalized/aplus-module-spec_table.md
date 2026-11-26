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
- 构图：按画幅左右或上下分区，一侧用带接触阴影的商品图，另一侧留连续净底承托两列表格。左对齐字段和值，以细行线和统一行距引导阅读，让点缀色只落在表头。
- 文案：短标题及至多 6 行「参数名：参数值」，移动端优先 4 行。一个数值和其对应的单位、测量条件放在同一行，省去缺值或条件说不完整的行。
- 合规：不根据品类补猜参数，不添加空行、虚构认证或规格，也不把待补充占位画出来。

## User Prompt Template

模块代码：{{moduleCode}}
