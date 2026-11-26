---
code: aplus.module.multi_angle
name: "A+详情 · 多角度图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"multi_angle"}'
---

# A+详情 · 多角度图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 多角度图

- 模块目标：在单张图中展示同一商品的多个可确认视角。
- 构图：把有原图依据的完整视角陈列在高低错落的几何展台上，或沿高反差渐变净底等距无框排列。尺度、光向一致，用接触阴影或微倒影落地，细线脚标靠近对应视角。只有一张原图时只画一个完整视角，最多配两处该图清晰可见的局部。
- 文案：可用简短模块标题和每个视角或局部配 2–4 字标签。完整视角按角度命名，原图局部按部位命名，例如「侧键」「滚轮」。
- 合规：不补造原图看不到的接口、按键或结构。未覆盖完整视角时不写全景或 360°。

## User Prompt Template

模块代码：{{moduleCode}}
