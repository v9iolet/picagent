---
code: aplus.module.comparison
name: "A+详情 · 效果对比图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"comparison"}'
---

# A+详情 · 效果对比图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 效果对比图

- 模块目标：用可靠的自身对比说明使用前后、新旧款或规格间的真实差异。
- 构图：用左右或上下对分，固定视角、光线和尺度，只突出一个已有依据的差异。缺少对比事实时，用商品和场景作描述性展示，不暗示未经证实的效果。
- 文案：两侧各用短标签标明对应状态，可配一句不超过 14 字的、有依据的结论。
- 合规：沿用 comparison 定义。不得出现竞品品牌、竞品商品或泛称的竞品替代物，不写「最好」「第一」等无依据比较，不夸大效果或承诺医疗功效。

## User Prompt Template

模块代码：{{moduleCode}}
