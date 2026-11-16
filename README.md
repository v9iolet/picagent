# PicAgent Studio · 电商智能生图工作台

PicAgent 桌面端套图工作台独立项目。

当前已建立 Ticket 01 的正式前端应用骨架，后续能力按 `docs/PRD-套图工作台-V1.md` 逐步接入。

## 本地运行

```powershell
npm install
npm run api
# 在另一个终端启动前端
npm run dev -- --host 127.0.0.1 --port 5173
```

按 `.env.example` 在 `.env` 中配置 PostgreSQL、MinIO 等基础设施。启动后，在左侧「配置 → 渠道」填写 OpenAI 兼容渠道、API Key 和模型 ID，再到「偏好设置」选择默认生图和多模态模型。接口地址填写兼容 API 的基础地址，例如 `https://api.example.com/v1`。仅填域名时使用 `/v1`；如果网关有自定义路径，请填写完整 API 前缀。

既有实例升级后也请在配置页手动补录渠道和默认模型。补录后即可提交新的生成任务。历史图片和提示词快照继续可读。

可访问路由：

- `/suites/new`
- `/suites/:suiteId`
- `/suites/:suiteId/board`
- `/settings`
- `/settings/preferences`

类型检查与生产构建：

```powershell
npm run typecheck
npm run build
```

## 当前范围

- 桌面端，不做移动端；
- 1–6 张原图上传、白底精修、套图计划、卡片生成和历史版本；
- 生图和多模态模型在配置页维护，由实例内成员共用；
- PostgreSQL 和 MinIO 使用服务器实例；
- 登录界面与权限暂不作为首版工作台开发阻塞项。

## 文档

- [套图工作台 V1 PRD](docs/PRD-套图工作台-V1.md)
- [生图网关接口示例](docs/gpt-image-2.md)
- [原型基准说明](docs/原型基准说明.md)

## 原型

原型入口位于 `prototype/index.html`。后续套图工作台开发以 `prototype/` 中的套图创建首页和套图创作工作台为交互与页面结构基准。
