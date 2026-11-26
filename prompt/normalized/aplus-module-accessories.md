---
code: aplus.module.accessories
name: "A+详情 · 配件/赠品图"
kind: planner
stage: aplus_module_rule
execution_target: llm
applicability: '{"moduleCode":"accessories"}'
---

# A+详情 · 配件/赠品图

## 用户输入字段

```yaml
fields:
  - key: moduleCode
    label: "模块代码"
    type: text
    required: true
```

## System Prompt

### 配件/赠品图

- 模块目标：让浏览者明确实际会收到哪些物品。
- 构图：俯拍一张铺满画幅的清单台面，用主商品建立视觉重心，已确认随货的配件、赠品或说明书按大小错落排在一侧。侧光形成同向阴影，标签紧邻对应物品，物品之间留出可辨间距。
- 文案：可用包装清单作短标题。物品名称尽量用短句，数量按输入记录标注，未确认数量时省略。
- 没有明确包装清单时，展示商品本体以及已确认的可见特征，用商品介绍作标题，省去「您将收到」等收货承诺。照片能确认外观，随货数量需要商品卡或卖家事实。
- 合规：场景道具、参照物和图中未证实随货的物品不得列入清单，不虚构赠品或配件。

## User Prompt Template

模块代码：{{moduleCode}}
