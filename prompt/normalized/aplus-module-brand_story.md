---
code: aplus.module.brand_story
name: "A+详情 · 品牌故事图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"brand_story"}'
---

# A+详情 · 品牌故事图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 品牌故事图

- 模块目标：传达输入已确认的品牌理念、初心或表达风格。
- 构图：按杂志跨页安排商品与品牌短句。把原图商品放在一侧，用侧光带出轮廓，让另一侧连续的背景纹理渐弱以承托文字。选不露出商品和包装标识的角度，将文字置于中心安全区。
- 文案：标题或口号不超过 12 字，正文按画幅读取难度缩短。输入缺品牌资料时只留一句能对应可见设计的短标题。
- 合规：整张图不得出现 Logo，不生成品牌标识或独立品牌素材。不虚构品牌名称、历史、创始人、产地、资质或奖项。

## User Prompt Template

模块代码：{{moduleCode}}
