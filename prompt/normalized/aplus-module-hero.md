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
- 构图：采用商业广告级满幅出血海报。按品类选有前中后景的立体置景或戏剧化轮廓光，商品约占画面 40–60%，以一个焦点呈现完整外形与质感。标题落在中心安全区内的负空间，避免平淡纯色底居中摆拍。
- 文案：主标题 4–10 字，副标题 10–20 字，围绕一个核心价值，最多给一个适用条件完整的规格。确需展示型号时，把型号放在标题区并留足边距。
- 合规：不堆砌卖点或夸大功效，不添加无依据的数据、新品标识或促销承诺。

## User Prompt Template

模块代码：{{moduleCode}}
