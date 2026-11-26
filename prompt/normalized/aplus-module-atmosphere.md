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
- 构图：用前中后景表现空间与光线，例如晨昏斜光掠过桌面纹理、百叶窗投影在远墙上，或商品近景衬城市散景。保持商品焦点，给一句杂志式短标题留出大片干净环境。与使用场景图错开景别，减少人物动作与信息密度。
- 文案：主文案是一句不超过 14 字的情绪短句，必要时加一句同语言的小字。
- 合规：氛围元素不得暗示未经验证的功能、适用环境或随商品附赠的物品。

## User Prompt Template

模块代码：{{moduleCode}}
