# 生图模型渠道与能力实测记录

本文汇总云飞渠道的接口资料，以及项目在生图渠道 omyai（`omyai-生图`）上对 `gpt-image-2.5-flare-special` 和 `gpt-image-2.6-flare-special` 的实测记录。能力以各节注明的渠道、模型和账号分组为准。

## 云飞渠道接口资料

### gpt-image-2
图像生成
01
文生图

仅使用文字提示词生成图片，请求体为 JSON。

POST
https://img.yunfei.best/v1/images/generations
请求参数
参数	必填	说明
model	是	固定为 gpt-image-2
prompt	是	文字提示词，中英文皆可
size	否	1K 分组最高支持 1K；4K 分组支持 1K / 2K / 4K；默认 auto
quality	否	high 分组支持 high；其他分组默认 medium
n	是	请固定传 1
response_format	否	url（默认）或 b64_json
请求
命令行
复制
curl https://img.yunfei.best/v1/images/generations \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "湖蓝色调的山谷,清晨薄雾,极简插画风",
    "size": "1024x1536",
    "n": 1
  }'
响应
网址格式
复制
{ "created": 1781837823, "data": [{ "url": "https://xxx.png" }] }
图片编码格式
复制
{ "created": 1781837823, "data": [{ "b64_json": "<BASE64>" }] }
网址默认保存 15 分钟，建议尽快下载。传 response_format=b64_json 时，图片编码位于 data[0].b64_json。
02
图生图

上传一张或多张参考图进行编辑，请求体为表单。

POST
https://img.yunfei.best/v1/images/edits
请求参数
参数	必填	说明
model	是	固定为 gpt-image-2
image / image[]	是	PNG / JPEG / WebP 文件，可重复传入
prompt	是	编辑要求；多图可用“第一张 / 第二张”指代
size	否	不传则沿用参考图尺寸；1K 分组最高支持 1K；4K 分组支持 1K / 2K / 4K
quality	否	high 分组支持 high；其他分组默认 medium
n	是	请固定传 1
response_format	否	url（默认）或 b64_json
请求
单张参考图
复制
curl https://img.yunfei.best/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=gpt-image-2" -F "image=@otter.png" -F "n=1" \
  -F "prompt=给这只海獭戴上一顶贝雷帽"
多张参考图
复制
curl https://img.yunfei.best/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=gpt-image-2" -F "image[]=@teapot.png" -F "image[]=@duck.png" -F "n=1" \
  -F "prompt=把第二张图的小鸭子放在第一张图的茶壶旁边"
响应
网址格式
复制
{ "created": 1781837823, "data": [{ "url": "https://xxx.png" }] }
图片编码格式
复制
{ "created": 1781837823, "data": [{ "b64_json": "<BASE64>" }] }
网址默认保存 15 分钟，建议尽快下载。传 response_format=b64_json 时，图片编码位于 data[0].b64_json。
香蕉&香蕉2
香蕉图像生成

使用 Gemini 原生 generateContent 接口，模型名填写在请求网址中，不属于 JSON 请求体。

网址中的模型
外号	模型名	取向
香蕉 Pro	gemini-3-pro-image-preview	画质档，适合成品
香蕉2	gemini-3.1-flash-image-preview	速度档；额外支持 8:1、4:1、1:4、1:8
比例与像素
比例	1K	2K	4K
1:1	1024×1024	2048×2048	4096×4096
16:9	1376×768	2752×1536	5504×3072
9:16	768×1376	1536×2752	3072×5504
4:3	1200×896	2400×1792	4800×3584
3:4	896×1200	1792×2400	3584×4800
3:2	1264×848	2528×1696	5056×3392
2:3	848×1264	1696×2528	3392×5056
5:4	1152×928	2304×1856	4608×3712
4:5	928×1152	1856×2304	3712×4608
21:9	1584×672	3168×1344	6336×2688
仅香蕉2支持超宽长条：1K 下 8:1 = 2928×352、4:1 = 2064×512、1:4 = 512×2064、1:8 = 352×2928；2K / 4K 分别按 ×2 / ×4。
03
文生图

在网址中选择模型，在 contents 的文字 part 中填写提示词。

POST
https://img.yunfei.best/v1beta/models/gemini-3-pro-image-preview:generateContent
请求头
鉴权与格式
复制
x-goog-api-key: <API_KEY>
# 也兼容 Authorization: Bearer <API_KEY>
Content-Type: application/json
请求参数
参数	必填	说明
contents[].role	是	固定填写 user
contents[].parts[].text	是	文字提示词
generationConfig.responseModalities	否	["IMAGE"] 返回图片编码（默认）；["TEXT"] 返回网址；["IMAGE","TEXT"] 两者都返回
generationConfig.imageConfig.aspectRatio	否	输出比例；需要自动比例时省略，不要传 auto
generationConfig.imageConfig.imageSize	否	1K / 2K / 4K，K 必须大写
请求
文生图
复制
curl -X POST "https://img.yunfei.best/v1beta/models/gemini-3-pro-image-preview:generateContent" \
  -H "x-goog-api-key: <API_KEY>" -H "Content-Type: application/json" \
  -d '{
    "contents": [ { "role": "user", "parts": [ { "text": "木桌上的红苹果,棚拍光线,极简背景" } ] } ],
    "generationConfig": {
      "responseModalities": ["IMAGE"],
      "imageConfig": { "aspectRatio": "1:1", "imageSize": "1K" }
    }
  }'
响应
responseModalities	响应字段
["IMAGE"]	candidates[0].content.parts[0].inline_data.data
["TEXT"]	candidates[0].content.parts[1].file_data.file_uri
["IMAGE","TEXT"]	以上两个字段都返回
同时返回图片编码和网址
复制
{
  "candidates": [{
    "content": {"parts": [
      {"inline_data": {"mime_type": "image/png", "data": "<BASE64>"}},
      {"file_data": {"file_uri": "https://xxx.png"}}
    ]}
  }]
}
04
图生图

在文字部件外加入图片部件，支持图片编码、网址或混合输入。

POST
https://img.yunfei.best/v1beta/models/gemini-3-pro-image-preview:generateContent
请求头
鉴权与格式
复制
x-goog-api-key: <API_KEY>
# 也兼容 Authorization: Bearer <API_KEY>
Content-Type: application/json
请求参数
参数	必填	说明
contents[].role	是	固定填写 user
contents[].parts[].text	是	编辑要求
contents[].parts[].inline_data	二选一	包含 mime_type 和 data，输入图片编码
contents[].parts[].file_data	二选一	包含 mime_type 和 file_uri，输入公网图片网址
generationConfig.responseModalities	否	["IMAGE"]、["TEXT"] 或 ["IMAGE","TEXT"]
generationConfig.imageConfig.aspectRatio	否	省略时根据参考图自动决定，不要传 auto
generationConfig.imageConfig.imageSize	否	1K / 2K / 4K
多个 inline_data / file_data 可以混用，并按它们在 contents[].parts 中的顺序处理。
请求
输入图片编码
复制
curl -X POST "https://img.yunfei.best/v1beta/models/gemini-3-pro-image-preview:generateContent" \
  -H "x-goog-api-key: <API_KEY>" -H "Content-Type: application/json" \
  -d '{
    "contents": [ { "role": "user", "parts": [
      { "text": "改成日系水彩风,保留主体和构图" },
      { "inline_data": { "mime_type": "image/png", "data": "<BASE64>" } }
    ] } ],
    "generationConfig": {
      "responseModalities": ["IMAGE"],
      "imageConfig": { "imageSize": "2K" }
    }
  }'
输入图片网址时替换为
复制
"file_data": {"mime_type":"image/png","file_uri":"https://example.com/input.png"}
响应
responseModalities	响应字段
["IMAGE"]	candidates[0].content.parts[0].inline_data.data
["TEXT"]	candidates[0].content.parts[1].file_data.file_uri
["IMAGE","TEXT"]	以上两个字段都返回
同时返回图片编码和网址
复制
{
  "candidates": [{
    "content": {"parts": [
      {"inline_data": {"mime_type": "image/png", "data": "<BASE64>"}},
      {"file_data": {"file_uri": "https://xxx.png"}}
    ]}
  }]
}
只传 imageSize 并省略 aspectRatio 时，输出自动跟随参考图比例；两者都省略时，比例和输出档位都交给上游决定。
veo视频
异步视频生成

每次提交先返回任务 id，再轮询到 completed 后取片。比例默认 16:9，duration 必填。

05
文生视频

不传参考图，仅根据提示词生成视频。

POST
https://img.yunfei.best/v1/videos
请求参数
参数	必填	说明
model	是	veo-3.1-fast-generate-preview、veo-3.1-generate-preview 或 veo-3.1-generate-preview-ref
prompt	是	提示词，不要写比例和时长
duration	是	4 / 6 / 8 秒，兼容 seconds
aspect_ratio	否	16:9 或 9:16，默认 16:9
generate_audio	否	是否生成音频，默认 true；兼容 generateAudio
negative_prompt	否	负向提示词；兼容 negativePrompt
输出分辨率	—	720p
veo-3.1-generate-preview-ref 不传图片时等同普通文生视频。
请求
文生视频
复制
curl -X POST "https://img.yunfei.best/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"veo-3.1-fast-generate-preview","prompt":"a paper boat sailing down a rain puddle, cinematic","duration":4,"aspect_ratio":"16:9"}'
响应与轮询
提交响应
复制
{ "id": "xxxx", "status": "queued" }
轮询请求
复制
curl "https://img.yunfei.best/v1/videos/{id}" -H "Authorization: Bearer <API_KEY>"
生成完成响应
复制
{ "id": "xxxx", "status": "completed", "url": "https://xxx.mp4" }
建议每 5～10 秒轮询一次。当 status 为 completed 时，从 url 获取视频地址；failed 表示失败，失败不扣费。
queued 已排队
in_progress 生成中
completed 可取片
failed 失败
06
单图生视频

上传一张首帧图片驱动视频，适用于快速和标准模型。

POST
https://img.yunfei.best/v1/videos
请求参数
参数	必填	说明
model	是	veo-3.1-fast-generate-preview 或 veo-3.1-generate-preview
prompt	是	运动和镜头要求，不要写比例与时长
image_url	是	公网直链、dataURL 或裸 base64
duration	是	4 / 6 / 8 秒，兼容 seconds
aspect_ratio	否	16:9 或 9:16，默认 16:9
generate_audio	否	音频开关，默认 true；兼容 generateAudio
negative_prompt	否	负向提示词；兼容 negativePrompt
输出分辨率	—	720p
图片不支持 {"data":"...","mime_type":"..."} 对象格式。
请求
单图生视频
复制
curl -X POST "https://img.yunfei.best/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"veo-3.1-fast-generate-preview","prompt":"镜头缓缓推进,人物转头微笑","duration":4,"aspect_ratio":"16:9","image_url":"https://example.com/first-frame.jpg"}'
响应与轮询
提交响应
复制
{ "id": "xxxx", "status": "queued" }
轮询请求
复制
curl "https://img.yunfei.best/v1/videos/{id}" -H "Authorization: Bearer <API_KEY>"
生成完成响应
复制
{ "id": "xxxx", "status": "completed", "url": "https://xxx.mp4" }
建议每 5～10 秒轮询一次。completed 后从 url 获取视频地址；failed 表示失败，失败不扣费。
07
首尾帧视频

传两张图片生成中间过渡，第 1 张为首帧，第 2 张为尾帧。

POST
https://img.yunfei.best/v1/videos
请求参数
参数	必填	说明
model	是	veo-3.1-fast-generate-preview 或 veo-3.1-generate-preview
prompt	是	过渡和镜头要求，不要写比例与时长
image_urls	是	第 1 张为首帧，第 2 张为尾帧；支持公网直链、dataURL 或裸 base64
duration	是	4 / 6 / 8 秒，兼容 seconds
aspect_ratio	否	16:9 或 9:16，默认 16:9
generate_audio	否	音频开关，默认 true；兼容 generateAudio
negative_prompt	否	负向提示词；兼容 negativePrompt
输出分辨率	—	720p
图片不支持 {"data":"...","mime_type":"..."} 对象格式。
请求
首尾帧视频
复制
curl -X POST "https://img.yunfei.best/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{
    "model":"veo-3.1-generate-preview","prompt":"生成自然连续的电影感过渡","duration":8,"aspect_ratio":"16:9",
    "image_urls":["https://example.com/first.jpg","https://example.com/last.jpg"]
  }'
响应与轮询
提交响应
复制
{ "id": "xxxx", "status": "queued" }
轮询请求
复制
curl "https://img.yunfei.best/v1/videos/{id}" -H "Authorization: Bearer <API_KEY>"
生成完成响应
复制
{ "id": "xxxx", "status": "completed", "url": "https://xxx.mp4" }
建议每 5～10 秒轮询一次。completed 后从 url 获取视频地址；failed 表示失败，失败不扣费。
08
多参考图视频

使用多张参考图保持主体与场景一致，仅适用于参考模型。

POST
https://img.yunfei.best/v1/videos
请求参数
参数	必填	说明
model	是	固定为 veo-3.1-generate-preview-ref
prompt	是	视频内容和运动要求，不要写比例与时长
image_urls	是	参考图数组；支持公网直链、dataURL 或裸 base64
duration	是	带图时固定为 8 秒，兼容 seconds
aspect_ratio	是	带图时固定为 16:9
generate_audio	否	音频开关，默认 true；兼容 generateAudio
negative_prompt	否	负向提示词；兼容 negativePrompt
输出分辨率	—	720p
图片不支持 {"data":"...","mime_type":"..."} 对象格式。传 4 / 6 秒或 9:16 会生成失败，失败不扣费。
请求
三图多参考
复制
curl -X POST "https://img.yunfei.best/v1/videos" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{
    "model":"veo-3.1-generate-preview-ref","prompt":"保持主体和场景一致,生成电影感动态镜头","duration":8,"aspect_ratio":"16:9",
    "image_urls":["https://example.com/1.jpg","https://example.com/2.jpg","https://example.com/3.jpg"]
  }'
响应与轮询
提交响应
复制
{ "id": "xxxx", "status": "queued" }
轮询请求
复制
curl "https://img.yunfei.best/v1/videos/{id}" -H "Authorization: Bearer <API_KEY>"
生成完成响应
复制
{ "id": "xxxx", "status": "completed", "url": "https://xxx.mp4" }
建议每 5～10 秒轮询一次。completed 后从 url 获取视频地址；failed 表示失败，失败不扣费。

## 实测结论：omyai / gpt-image-2.5-flare-special

项目实测模型统一为 **`gpt-image-2.5-flare-special`**，使用数据库模型设置中的默认生图渠道 **omyai（`omyai-生图`）** 和接口 `https://omyai.vip/v1/images/edits`。以下记录仅代表实测账号、模型和渠道，不等同于整个模型系列或其他分组的能力；不要直接套用上文云飞渠道或香蕉章节的参数表。

### 档位、基础比例与省略 size（2026-11-21，`legacy` 用例集）

脚本：[scripts/probe-gpt-image-size.ts](../scripts/probe-gpt-image-size.ts)。从项目 `.env` 读取 PostgreSQL 配置，只读模型设置并通过现有 `ModelSettings.resolve("image")` 解析默认生图模型，不输出 API Key。本组共 8 次 POST，无自动重试、无图片 URL 下载；`quality=medium`、`n=1`、`response_format=b64_json`。参考图由 sharp 生成浅灰色 PNG，前 7 次 512×512，第 8 次 512×768。统一提示词要求保持参考图构图及比例、在中心添加深蓝色小圆，不添加文字。下表宽高读取返回图片的实际 metadata，不根据请求参数推算。

| 请求 | size | 参考图 | HTTP | 实际输出宽×高 | 耗时（ms） | 脱敏错误体前 500 字 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `1K` | 512×512 | 200 | 1024×1024 | 33538 | 空 |
| 2 | `2K` | 512×512 | 200 | 2048×2048 | 25850 | 空 |
| 3 | `4K` | 512×512 | 200 | 2880×2880 | 41102 | 空 |
| 4 | `1024x1536` | 512×512 | 200 | 1024×1536 | 25169 | 空 |
| 5 | `1536x1024` | 512×512 | 200 | 1536×1024 | 25215 | 空 |
| 6 | `1024x1024` | 512×512 | 200 | 1024×1024 | 25593 | 空 |
| 7 | 不传 | 512×512 | 200 | 2880×2880 | 26811 | 空 |
| 8 | 不传 | 512×768 | 200 | 2880×2880 | 27358 | 空 |

- **档位接受情况**：本账号接受 `1K`、`2K`、`4K` 并成功返回可解码图片（请求 1–3）。但 `4K` 实际为 2880×2880，不能承诺 4096×4096，也不能据此推断所有账号分组支持 4K。
- **像素值**：实测的 `1024x1536`、`1536x1024`、`1024x1024` 均按指定像素返回（请求 4–6），对应 2:3、3:2、1:1；可为当前模型选择像素模式。本轮未覆盖的新比例与高分辨率像素见下轮实测。
- **省略 size**：方形与非方形参考图都返回 2880×2880（请求 7–8）；尤其 512×768 的 2:3 参考图仍返回 1:1，即使提示词要求保持比例。本次不传 size 没有跟随非方形参考图比例，也没有保持参考图原始像素尺寸。因此需要确定比例时，应显式传已验证的像素值。
- **超限错误体 / `IMAGE_SIZE_UNSUPPORTED`**：8 次均为 HTTP 200，未出现超限或分组限制错误，错误体为空。此轮没有可用于识别该错误的失败样本。

### 新比例与负对照（2026-11-22 UTC，`ratios` 用例集）

先 dry-run 确认目标模型与渠道，再串行发送 7 次 POST，无重测；参数、提示词与上轮一致，参考图均为 512×512。只读查询未发现该模型存有显式 `imageOptions`，因此使用系列默认能力。前五例的 `size` 由 `resolveImageSize` 生成，末两例故意绕过换算，检验渠道如何处理异常尺寸。实际宽高均取自返回图片，不是从 `size` 推算。

| 请求 | 用例 | 请求 size | HTTP | 实际输出宽×高 | 耗时（ms） | 脱敏错误体 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 1K · 3:4 | `1024x1360` | 200 | 1024×1360 | 28576 | 空 |
| R2 | 1K · 4:3 | `1360x1024` | 200 | 1360×1024 | 42010 | 空 |
| R3 | 1K · 16:9 | `1824x1024` | 200 | 1824×1024 | 26466 | 空 |
| R4 | 1K · 9:16 | `1024x1824` | 200 | 1027×1824 | 27623 | 空 |
| R5 | 2K · 2:3 | `2048x3072` | 200 | 2048×3072 | 30338 | 空 |
| R6 | 负对照：非 16 倍数 | `1024x1365` | 200 | 1024×1360 | 25715 | 空 |
| R7 | 负对照：极端长边 | `16384x16` | 200 | 2880×2880 | 26240 | 空 |

- **换算规则**：短边分别取上轮请求 1–3 的方图边长 1024、2048、2880，长边按目标比例取最近的 16 像素。R1 与 R6 最终都得到 1024×1360，故直接请求 1360，而非 1365；这是客户端取整策略，不是上游拒绝非 16 倍数的证据。
- **请求与成品要区分**：R1–R5 均收到可解码图片；R1–R3、R5 尺寸完全一致，R4 却比请求宽 3 像素。不能承诺像素或比例精确交付。本轮 2K 非方形只测了 R5；下一轮另测了三个高档位组合。
- **没有真实失败样本**：R6 被调整为 1024×1360，R7 返回 2880×2880 方图；二者都是 200 且无错误体。不能据此推断硬性限制、错误格式或状态码，故不改变 `IMAGE_SIZE_UNSUPPORTED` 的识别规则。

### 高档位非方形（2026-11-22 UTC，`high-res` 用例集）

只读解析默认模型并 dry-run 核对上述模型、端点和下表三例后，按序各发一次 POST，没有重试或重测。参数与 R1–R5 相同，`size` 由 `resolveImageSize` 换算。判定只看**比例**：以 `size` 的宽高比为基准，偏差 = `abs((实际宽 / 实际高) / 基准比例 - 1) × 100%`，大于 1% 为不可用。另列相对用户所选比例的偏差，以区分客户端取整和上游调整。

| 请求 | 档位 · 所选比例 | 请求 size | HTTP | 实际输出宽×高 | 耗时（ms） | 相对请求 size 偏差 | 相对所选比例偏差 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| H1 | 4K · 16:9 | `5120x2880` | 200 | 3840×2161 | 30518 | 0.046% | 0.046% |
| H2 | 4K · 3:4 | `2880x3840` | 200 | 2506×3312 | 32222 | 0.886% | 0.886% |
| H3 | 2K · 16:9 | `3648x2048` | 200 | 3648×2053 | 30191 | 0.244% | 0.049% |

**本轮无比例不可用组合，但三例均未按请求像素精确交付。** 本次实测的两张非方形图片均未达到所请求的 4K 标称像素：16:9 实际为 3840×2161，3:4 实际为 2506×3312。H1、H2 的两条边均被缩小，H3 的高度增加 5 像素；三例都未变为方图。每个组合只有一个样本，不代表其他组合可用，也不能据此推断固定的上游长边上限。本次不改变档位换算或可选比例。

复现前仅预览用例（不发图像请求）：

```sh
npx tsx scripts/probe-gpt-image-size.ts --case-set legacy --dry-run
npx tsx scripts/probe-gpt-image-size.ts --case-set ratios --dry-run
npx tsx scripts/probe-gpt-image-size.ts --case-set high-res --dry-run
```

真实运行需另获授权，将 `--dry-run` 换为 `--output /tmp/<新的文件名>.jsonl`。脚本只允许对上述实测模型和端点发请求，并拒绝覆盖已有输出。脱敏 JSONL 包含模型与渠道快照、请求开始时间、参考图 SHA-256、HTTP 状态、实际宽高及耗时。原始结果表分别见本地票 `01-gpt-image-size-probe.md`、`12-image-ratio-options.md`、`14-high-res-ratio-probe.md` 的 Comments。

### 蒙版语义

**灰度和 RGBA 两种蒙版编码都未能约束编辑范围。** 该结论仅适用于本次测试的 `omyai-生图` 渠道及 `gpt-image-2.5-flare-special` 模型。

2026-11-25（北京时间），使用默认渠道 `omyai-生图` 的 `gpt-image-2.5-flare-special` 请求 `https://omyai.vip/v1/images/edits`。用同一张 1024×1024 的合成来源图和同一个矩形选区，分别以灰度 PNG（白色为编辑区）和 RGBA PNG（alpha=0 为编辑区）各做一次局部重绘和消除。每次请求 `size=1024x1024`、`quality=medium`、`n=1`、`response_format=b64_json`，共 4 次，无重试。

来源图有三个相同的红圆，选区只覆盖右圆。两种编码使用相同的重绘及消除提示词，只指明处理蒙版内的红圆，分别要求变蓝和移除。按相同坐标比较输出与来源图，计算 RGB 三通道平均绝对差（MAE，0–255，0 表示完全一致）。另取每个红圆中心半径 48 像素内的区域计算 MAE，避免大面积浅色背景掩盖选区外红圆的变化。

本地样图与原始数据位于主检出目录的 `.scratch/image-editor-upgrade/mask-probe-2026-11-25/`，含 `reference.png`、`mask-grayscale.png`、`mask-rgba.png`、下表列出的 4 张结果图和 `results.jsonl`。复现脚本见 [scripts/probe-gpt-image-mask.ts](../scripts/probe-gpt-image-mask.ts)。使用 `--dry-run` 可核对默认渠道和四个用例，真实运行需另获授权并传入 `--live --output <新目录>`。

四次请求均返回 HTTP 200 和 1024×1024 的图片。

| 编码 | 工具 | 样图文件 | 选区外 MAE | 选区内 MAE | 左圆 / 中圆 / 右圆 MAE | 目视结果 |
| --- | --- | --- | ---: | ---: | --- | --- |
| 灰度 | 局部重绘 | `grayscale-redraw.png` | 6.221 | 58.641 | 125.407 / 125.769 / 125.590 | 三个圆全部变蓝 |
| 灰度 | 消除 | `grayscale-erase.png` | 7.351 | 62.328 | 136.702 / 136.794 / 136.810 | 三个圆全部消失 |
| RGBA | 局部重绘 | `rgba-redraw.png` | 7.808 | 63.969 | 138.559 / 138.476 / 138.353 | 三个圆全部变蓝 |
| RGBA | 消除 | `rgba-erase.png` | 7.272 | 62.563 | 137.099 / 137.021 / 137.058 | 三个圆全部消失 |

#### 降级路径实测

2026-11-25（北京时间），在同一渠道和模型上，按实际编辑器路径各发起一次局部重绘、消除和扩图。使用默认编辑质量 `high`，每次 `n=1`，均无重试，快照均为 `maskApplied=false`，请求均未发送蒙版。测试图是合成素材，未附带商品原图。

局部重绘和消除复用上轮的 1024×1024 三红圆原图，用直径 160 px 的圆形笔刷选最右侧圆。请求提示词含笔刷边界生成的区域描述，并点明保留左圆和中圆。下表的矩形外 MAE 沿用上轮 160×160 的矩形边界，圆内 MAE 仍取原坐标中心半径 48 px。两轮的提示词和质量不同，数值只用于比较这两轮样本的表现。

| 工具 | 样图文件 | 请求 / 输出尺寸 | 耗时 | 笔刷外 / 矩形外 MAE | 左圆 / 中圆 / 右圆 MAE | 目视结果 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 局部重绘 | `redraw.png` | 1024×1024 / 1024×1024 | 37.4 秒 | 3.495 / 3.498 | 1.124 / 1.143 / 127.155 | 右圆变蓝，左圆和中圆保持红色，背景有细微纹理变化 |
| 消除 | `erase.png` | 1024×1024 / 1024×1024 | 31.1 秒 | 4.889 / 4.895 | 2.521 / 2.539 / 136.982 | 右圆消失并由邻近背景补齐，左圆和中圆保持红色，背景有细微纹理变化 |

矩形外 MAE 从上轮的 6.221–7.808 降至 3.498–4.895。上轮四张图的左圆和中圆都被改动，本轮两张图都保留了这两个圆的颜色及位置。选区外仍有像素变化。

扩图把 1824×1024 的横图放入 1827×3248 的 9:16 画布，原图居中，上下各填充 1112 px 的中性灰色。请求尺寸为 `1024x1824`，69.9 秒后返回 `outpaint.png`，实出 1027×1824，比请求宽 3 px。瓶子和文字保留在画幅中部，左文右图的构图基本保持，两行原文 `NORTH STUDIO` 和 `COASTAL EDITION` 完整可读。上方延续墙面，下方延续桌面，目视连接自然，未见灰色边带或明显接缝。原图区域的颜色和纹理有轻微变化。

脚本通过 `ImageEditorService`、`requestImageEditorEdit` 和正式 provider 构造与发送请求。`--dry-run --reference <三红圆输入图>` 会核对默认渠道并用本地假 provider 预览请求。付费抽样使用 `--live --reference <三红圆输入图> --output <新目录>`，需先获授权。[复现脚本](../scripts/probe-mask-fallback.ts)

本次产物在主检出目录的 `.scratch/image-editor-upgrade/fallback-probe-2026-11-25/`，包含两张来源图、实际提交的 `outpaint-canvas.png`、三张结果图和 `results.jsonl`。

## 实测结论：omyai / gpt-image-2.6-flare-special

2026-11-25（北京时间），在已配置的 `omyai-生图` 渠道上通过 `/v1/images/edits` 单独选择 2.6。输入为白色无线鼠标实拍，`quality=medium`、`n=1`、`response_format=b64_json`。高级 A+ Web 交付比例为 1464:600，应用按 1K 档换算出 `size=2496x1024`。

| 请求 | 请求 size | HTTP | 实出尺寸 | 耗时 | 上游错误 |
| --- | --- | --- | --- | --- | --- |
| 首次预检 | `2496x1024` | 502 | 无 | 134.2 秒 | `524` |
| 同尺寸重试 | `2496x1024` | 200 | 2496×1024 | 35.0 秒 | 无 |

2.6 在本次成功样本中接受了 2496×1024 像素请求并按指定尺寸返回。走 A+ 的居中裁切后交付为 1464×600，鼠标边缘、滚轮和侧键完整。2.5 曾实测多种像素尺寸，部分组合返回尺寸有偏差。2.5 的记录未覆盖 2496×1024，目前无法比较两者在这组像素上的差异或成功率。

2026-11-26 的正式 A+ 批次用同一份 3C 商品卡规划默认 6 模块。Web 端的 6 张原图均实出 2496×1024。移动端请求 2736×2048，实出宽度均为 2736，高度为 2037–2052，交付图统一为 600×450。普通 A+ 首批成功样本请求 3312×2048，部分返回高度也有少量偏差，交付使用 970×600 的裁切图。同一账号把两个三并发批次同时提交时出现 HTTP 429 `concurrency_limit_exceeded`。

淘宝 3:4 的四个服饰模块均请求 2048×2736，均实出 2052×2736，比例为 3:4。通用比例直接交付实出像素。

原图、预检出图、裁切样图及逐次记录位于主检出目录的 `.scratch/a-plus-detail/tuning-assets/` 和 `.scratch/a-plus-detail/tuning-2026-11-25/`。
