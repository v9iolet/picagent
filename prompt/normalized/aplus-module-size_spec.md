---
code: aplus.module.size_spec
name: "A+详情 · 尺寸/容量/尺码图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"size_spec"}'
---

# A+详情 · 尺寸/容量/尺码图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 尺寸/容量/尺码图

- 模块目标：直观说明已确认的商品量度，帮助用户判断是否合适。
- 构图：按品类采用正侧视图配尺寸线、容量示意或服饰尺码表，数值与标注一一对应，避免把没有比例依据的道具画成尺度参照。
- 文案：短标题加尺寸、容量或尺码标签。每个数值保留输入单位，缺失时省去数值或只展示部位。
- 合规：不依据照片猜测尺寸、容量、尺码或重量，不添加未提供的误差、换算或适配范围。

## User Prompt Template

模块代码：{{moduleCode}}
