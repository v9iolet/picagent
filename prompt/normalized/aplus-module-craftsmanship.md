---
code: aplus.module.craftsmanship
name: "A+详情 · 工艺制作图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"craftsmanship"}'
---

# A+详情 · 工艺制作图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 工艺制作图

- 模块目标：把有资料支撑的选材、加工或制作过程讲清楚。
- 构图：画面中只允许出现一件完整商品主体。用侧光标出工艺所在部位，局部细节必须收在带清晰几何边框的放大视窗内，用引线对应实物位置；严禁在前景或背景画出第二件完整商品。有依据的工序可用文字时间轴串联。只有成品原图时，仅展示一到两处可见细节，省去工序编号、剖面和内部示意，不凭外观命名材料。
- 文案：短标题，每个已确认环节配 2–6 字步骤名及不超过 16 字的说明。
- 合规：不能用行业通用流程替代本商品的事实，不假造工厂、质检流程、资质或特殊工艺。

## User Prompt Template

模块代码：{{moduleCode}}
