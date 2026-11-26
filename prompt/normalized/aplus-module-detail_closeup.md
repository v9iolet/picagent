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
- 构图：优先用暗调或高反差侧逆光拍一个微距大特写，让纹理起伏和工艺边缘可辨。需交代部位时，一侧展示主体近景，另一侧用细引线连接带清晰细边框的局部放大窗。只取原图可确认的走线、按键或纹理，不排成多角度三联白框。
- 文案：每个细节配 4–8 字标题和不超过 16 字说明，数量按原图能支持的细节调整。
- 引线与放大窗必须对应原图中的同一个部位。移动端优先选两处，用部位名和至多一行说明，英文说明最多 8 个词。双端同选时，共用文案也按移动端字量收敛。
- 合规：结构与纹理需能在原图对应到真实部位。材质名称、加工方式、等级等事实必须有输入根据。

## User Prompt Template

模块代码：{{moduleCode}}
