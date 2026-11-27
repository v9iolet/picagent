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

## 管理员登录与鉴权

服务启动时会在 PostgreSQL 中初始化单个管理员账号，默认用户名为 `admin`，初始密码为 `woshisheng_666`。生产环境请设置强密码 `AUTH_ADMIN_PASSWORD`。显式配置后，服务会在启动时同步该账号的密码。

登录需要一次性图形验证码，验证码记录保存在 PostgreSQL，默认 3 分钟有效。登录成功后，服务签发默认有效期为 7 天的 HttpOnly 会话 Cookie。退出登录会立即撤销该会话。业务 API、上传、图片预览和下载均需有效会话。

`AUTH_COOKIE_SECURE=auto` 会根据 HTTPS 状态决定是否给 Cookie 加上 `Secure`，也可设为 `true` 或 `false` 固定开启或关闭。默认仅信任来自本机回环地址的反向代理，通过 `X-Forwarded-For` 首个地址识别客户端，通过 `X-Forwarded-Proto` 识别 HTTPS。`AUTH_TRUST_PROXY=false` 始终使用直连地址与 TLS 状态。仅当服务只能经可信代理访问，且代理会覆盖客户端传入的这两个头时，才设置 `AUTH_TRUST_PROXY=true`。

通过 Docker bridge 的宿主机网关反代时，容器看到的 `remoteAddress` 是网桥 IP。满足上述代理条件后，需要在 `.env` 中显式设置 `AUTH_TRUST_PROXY=true`，才能从转发头识别客户端 IP 和 HTTPS 状态。

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

## 生产部署

在项目根目录准备好 PostgreSQL、MinIO 的环境变量或 `.env`，使用与 Dockerfile 一致的 Node.js 22 构建并启动服务。

```bash
npm ci --include=dev
npm run build
NODE_ENV=production npm start
```

`npm run build` 将前端页面和静态资源写入 `dist/`，随后调用 `npm run build:server`，将服务端和共享模块编译到 `dist-server/`。单独更新服务端时可只运行 `npm run build:server`。`npm start` 执行 `node dist-server/server/index.js`，启动时读取 `db/migrations/` 执行迁移，并在同一端口提供 API 和前端页面。默认端口为 3001，健康检查路径 `/api/health` 需要有效会话。无需登录的 HTTP 存活探针可使用 `GET /api/auth/session`。

也可以从项目根目录构建多阶段 Docker 镜像。第一阶段 `builder` 安装构建依赖并完成前后端编译，第二阶段 `runner` 通过 `npm ci --omit=dev` 安装生产依赖，复制两个产物目录和数据库迁移。容器默认以 `NODE_ENV=production` 启动。

```bash
docker build -t picagent-studio .
docker run --env-file .env -p 127.0.0.1:3001:3001 picagent-studio
```

### 模型归档

| 环境变量 | 作用 |
| --- | --- |
| `MODEL_ARCHIVE_MODE` | `off` 关闭本地归档。`metadata` 保存请求与响应 JSON，包括文件类型、大小等元数据。`full` 另外保存输入与输出图片文件。默认在生产环境使用 `off`，其他环境使用 `full`。 |
| `MODEL_ARCHIVE_DIR` | 归档根目录，默认为相对工作目录的 `var/model-archives`。在容器中启用归档并需要保留文件时，把可写持久卷挂载到这个目录。 |

### 反向代理

在前置网关为 HTML、JS 和 CSS 开启 gzip 或 Brotli 压缩，并保留服务端返回的缓存头。带哈希的静态资源可长期缓存，入口 HTML 使用 `no-cache`，让浏览器在发布后重新验证入口。

复刻创建接口 `POST /api/replicas` 的请求体上限为 200 MiB。商品信息卡创建和更新接口（`POST /api/product-cards` 和 `PATCH /api/product-cards/:id`）的上限为 100 MiB。使用 Nginx 时，可在现有代理的 `server` 块设置 `client_max_body_size 200M;`，由应用按路由执行各自的上限。多级网关都需要允许对应大小，否则大图请求可能在到达应用前就收到 413。

按最大图片上传所需时间配置 `client_body_timeout` 和 `proxy_send_timeout`，并让各级网关的 `proxy_read_timeout` 覆盖后端同步调用的等待时间。生图服务单次上游调用默认最多等待 600 秒，代理还需为请求转发和返回结果留出余量。

## 文档索引

- [领域词汇与当前共识](CONTEXT.md)
- [架构决策记录 (ADR 0001–0012)](docs/adr/)
- [Agent 协作规范](AGENTS.md)
- [生图模型渠道与能力实测记录](docs/image-models.md)
- [平台规范维护参考](docs/平台维护表-海外优先.md)
