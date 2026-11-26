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
- 构图：用沉浸式满幅实景，或以电影感色调串联 2–3 个分栏镜头。让手与握持处、服饰与穿戴位置自然贴合，按目标市场和用途安排环境。让字幕落在品牌色通栏底条、渐变暗部或干净负空间。
- 文案：每个场景可配 4–8 字标题和不超过 16 字的一句说明，必要时加简短总标题。
- 高级 A+ 移动端优先一个使用场景。优先用短标题表达用途，确需说明时只留一行，场景字幕远离交付边缘。双端同选时，共用文案也按移动端字量收敛。
- 合规：只演示符合证据的用途，避免危险用法、未经证实的适配和夸大的使用结果。

## User Prompt Template

模块代码：{{moduleCode}}
