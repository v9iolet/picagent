# PicAgent Studio · 电商智能生图工作台

面向跨境与国内电商的桌面端商品视觉与上架内容工作台。支持上传商品实拍原图一键生成合规主图、卖点图、生活场景图及 16 平台差异化商品上架文案，并提供共享 XYFlow 生图画布、AI 局部图片编辑器、爆品图反推与图片/模板资产库。

## 本地运行

按 `.env.example` 在 `.env` 中配置 PostgreSQL 与 MinIO 连接信息：

```bash
npm install
npm run api
# 在另一个终端启动前端开发服务
npm run dev -- --host 127.0.0.1 --port 5173
```

启动后，在左侧导航「配置 → 渠道」添加 OpenAI 兼容协议渠道、API Key 与模型 ID（勾选生图 / 多模态能力并按账号分组调整支持的分辨率与比例），随后在「偏好设置」选择默认生图模型与默认多模态视觉模型。

## 核心入口与路由

- `/create/suite`（及 `/create/suite/:suiteId`）：AI 商品套图一键生成、多阶段进度追踪、原地图片精修与批次历史
- `/create/canvas`（及 `/create/canvas/:suiteId`）：三泳道生图画布、全局风格覆盖、AI 局部图片编辑与多平台成品交付视图（`?view=gallery`，支持打包导出图片、`listing-copy.md` 与 `manifest.json`）
- `/create/aplus`（及 `/create/aplus/:suiteId`）：A+详情策划、按模块出图、详情长图与 ZIP 导出
- `/create/replica`（及 `/create/replica/:suiteId`）：爆品图复刻、结果精修与批次历史
- `/reverse`（及 `/reverse/:planId`）：旧版爆品图反推记录
- `/products`：商品信息卡管理与创作入口
- `/assets`、`/templates`：图片资产库与提示词模板库（支持草稿编辑、版本发布与在线回溯）
- `/settings`、`/settings/preferences`：模型渠道与全局默认模型偏好设置

## 校验与构建

```bash
npm run typecheck
npm run build
npx tsx --test tests/*.test.ts
npm run test:pg
```

## 文档索引

- [领域词汇与当前共识](CONTEXT.md)
- [架构决策记录 (ADR 0001–0012)](docs/adr/)
- [Agent 协作规范](AGENTS.md)
- [生图模型渠道与能力实测记录](docs/image-models.md)
- [平台规范维护参考](docs/平台维护表-海外优先.md)
