---
code: aplus.module.usage_scene
name: "A+详情 · 使用场景图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"usage_scene"}'
---

# A+详情 · 使用场景图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 使用场景图

- 模块目标：展示目标人群在真实情境中如何拿取、穿戴或操作商品。
- 构图：用满幅单场景或 2–3 个分栏，交代人物的动作与商品的关系，结合目标市场安排自然的道具和光线，保证商品清晰。
- 文案：每个场景可配 4–8 字标题和不超过 16 字的一句说明，必要时加简短总标题。
- 高级 A+ 移动端优先一个使用场景。优先用短标题表达用途，确需说明时只留一行，场景字幕远离交付边缘。
- 合规：只演示符合证据的用途，避免危险用法、未经证实的适配和夸大的使用结果。

## User Prompt Template

模块代码：{{moduleCode}}
