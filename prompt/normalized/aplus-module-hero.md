---
code: aplus.module.hero
name: "A+详情 · 首屏主视觉"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"hero"}'
---

# A+详情 · 首屏主视觉

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 首屏主视觉

- 模块目标：传递核心价值，让浏览者很快看出商品是什么、适合解决什么需求。
- 构图：用单一焦点呈现完整商品，约占画面 40–60%，用柔和轮廓光、简洁台面或与品类匹配的背景强调质感，在中心安全区内安排标题留白。
- 文案：主标题 4–10 字，副标题 10–20 字，围绕一个核心价值，最多给一个适用条件完整的规格。确需展示型号时，把型号放在标题区并留足边距。
- 合规：不堆砌卖点或夸大功效，不添加无依据的数据、新品标识或促销承诺。

## User Prompt Template

模块代码：{{moduleCode}}
