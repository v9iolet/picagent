---
code: aplus.module.detail_closeup
name: "A+详情 · 商品细节图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"detail_closeup"}'
---

# A+详情 · 商品细节图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 商品细节图

- 模块目标：用实物细节表现材质质感、结构和工艺可见特征。
- 构图：选择 2–4 个有原图依据的细节，如走线、按键或纹理。用整体商品配放大窗、细引线，或在一张图内排成微距特写网格。
- 文案：每个细节配 4–8 字标题和不超过 16 字说明，数量按原图能支持的细节调整。
- 合规：结构与纹理需能在原图对应到真实部位。材质名称、加工方式、等级等事实必须有输入根据。

## User Prompt Template

模块代码：{{moduleCode}}
