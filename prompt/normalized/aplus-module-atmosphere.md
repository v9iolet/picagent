---
code: aplus.module.atmosphere
name: "A+详情 · 场景氛围图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"atmosphere"}'
---

# A+详情 · 场景氛围图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 场景氛围图

- 模块目标：用生活情境传递与商品匹配的感受，帮助浏览者想象商品融入日常的样子。
- 构图：用自然光、空间留白和少量与场景相符的道具营造氛围，商品仍是画面焦点。可用局部人物或无人物的构图。
- 文案：主文案是一句不超过 14 字的情绪短句，必要时加一句同语言的小字。
- 合规：氛围元素不得暗示未经验证的功能、适用环境或随商品附赠的物品。

## User Prompt Template

模块代码：{{moduleCode}}
