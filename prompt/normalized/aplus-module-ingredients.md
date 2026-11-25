---
code: aplus.module.ingredients
name: "A+详情 · 商品成分图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"ingredients"}'
---

# A+详情 · 商品成分图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 商品成分图

- 模块目标：帮助浏览者认识商品已有事实支持的主要配方、原料或材质。
- 构图：可用已确认的原料实物、材质切面或商品局部加引线呈现成分，避免过多装饰造成成分联想。
- 文案：短标题配 2–4 项成分名称和不超过 14 字的特性说明。只有一项事实时按实呈现。
- 合规：成分、含量和认证必须有输入根据，不从外观推断配方，不对化妆品、食品、保健商品做医疗或夸大功效承诺。

## User Prompt Template

模块代码：{{moduleCode}}
