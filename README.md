# Universal HTTP Video Studio

本地运行的通用多模态参考视频生成工作台。当前 App 版本为 **V0.5.10**。

## 当前能力

- Windows 资源管理器风格选择图片素材文件夹和视频输出目录；参考素材区拆分为独立的图片库、视频库和音频库；
- 视频库、音频库均按文件夹递归导入：视频库自动过滤 MP4/MOV/WebM/MKV/M4V，并将所选视频主文件夹持久化；超过 20 秒的视频直接跳过，不进入视频库。音频库自动过滤 MP3/WAV/M4A/AAC/OGG/FLAC；大型视频库采用当前 Tab 按需渲染、最多 60 条可见项、悬停后才加载视频预览，避免 200+ 视频同时创建媒体解码请求；
- 视频片段审核使用“开始秒数 → 结束秒数”直接选择。源视频超过 15 秒时必须先完成片段审核，裁剪文件由内置 FFmpeg 生成，原文件不修改；
- 每张提示词卡必须至少有 1 张参考图片；图片最多 9 张、视频最多 3 个、音频最多 3 个，全部参考文件合计最多 12 个；如出现第 4 个参考视频，前端选择与提交、服务端批次创建都会硬性阻止；
- 同一任务全部参考视频片段总时长不得超过当前输出时长，且不得超过 15 秒；参考音频片段总时长也不得超过当前输出时长，且不得超过 15 秒；超限、未审核或无参考图时均禁止提交，不做静默截断或自动丢弃；
- 提示词卡采用固定高度布局，并显示“参考审核”状态、图片/视频/音频计数、总文件数和视频总参考时长；
- 长提示词使用独立大编辑器编辑，卡片内仅保留可单独滚动的只读预览；手动输入 `@` 时仅显示当前卡片附件；直接粘贴包含完整 `@素材别名` 的提示词时可自动绑定图片，视频/音频同时支持通过 `@素材别名` 或 `@完整文件名（含扩展名）` 自动绑定。自动音视频引用会随提示词增删同步更新；
- 支持一次粘贴多条 Prompt 或整份 Markdown 自动拆卡：按每条“生成一段……X秒”识别边界并自动写入 4–15 秒输出时长，正文中的 `@素材名` 继续自动绑定；一次最多导入 200 条；
- 支持“全部卡片生成数量”一键批量设置，范围 1–99；批量导入时也可直接指定每条 Prompt 的生成数量；单条提示词编辑保存时如检测到明确 `X秒` 会同步更新该卡片时长；
- 支持按日期导出当天已完成视频的“视频文件名 + 原始 Prompt”UTF-8 Markdown，便于交给可直接读取本地视频文件夹的 AI；失败提示词按日期导出继续独立保留；
- 支持当前输入区全部提示词卡批量命名：统一设置文件名前缀、起始序号和 1–6 位序号宽度，例如 `M02_MicroClip_001`；仅覆盖卡片输出文件名，不改提示词、参考素材、时长和生成数量；
- 单次输出支持 4–15 秒，可选文件名、0–5 次提交失败重提、每卡 1–99 条视频；
- HTTP 提交采用“提示词卡分组并发”：默认并发上限 5，用户可设置 1–99；同一提示词卡的多个版本可并发提交，不同提示词卡之间按组依次提交，避免 TikTok Creative Studio 将不同提示词聚合到同一生成块；
- Cookie 加密存储与登录状态验证；
- 图片 HTTP 上传和 CDN 缓存；
- HTTP 生成提交并持久化 taskId；
- 持续轮询远端任务，直到出现正式可用的视频结果或明确失败；任务中心显示创建/首次提交/失败或完成时间、运行耗时和失败重提计数；
- 临时网络/服务类远端失败可在配置的失败重提额度内自动重新排队；审核/内容策略失败会记录远端错误码和失败时间，不自动重复提交；TikTok 审核拒绝会区分提示词文本、参考图片、参考视频或参考音频，不再统一显示成 Community Guidelines；
- 自动下载、格式校验、SHA-256 和结果入库；
- 程序重启后继续轮询或恢复下载；
- 任务中心和结果素材均可直接查看对应提示词；结果卡固定宽高，并提供提示词摘要、复制提示词和“复用并编辑”；任务中心支持删除单条已结束记录和一键删除全部已结束记录，进行中任务及已下载到磁盘的视频文件不会被删除；
- 支持按电脑本地日期导出失败提示词 Markdown：筛选当天 `submit_failed / remote_failed / download_failed`，导出任务名、失败时间、状态、错误码、错误信息、输出时长、参考素材快照和完整原始提示词；
- 从已提交任务中搜索并复用历史提示词，可恢复仍然有效的参考图；
- 内置“网络诊断”，可查看当前是 Windows 系统代理、环境变量代理还是直连，并测试广告后台连通性；Cookie 验证失败时直接显示具体原因，不再只显示 HTTP 422；
- Electron 客户端自动继承 Windows 系统代理和 PAC 规则；API 请求使用 Electron `net.request` 保留 Cookie 请求头，失败时自动使用系统代理 CONNECT 备用通道；环境变量 `PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` 仍具有更高优先级。

当前版本已经完成批量提示词自动拆卡、Prompt 输出时长自动识别、全部卡片生成数量批量设置、按日期导出视频文件名与原始提示词、当前卡片批量命名、按日期导出失败提示词、音频/视频参考的文件夹递归导入、视频主目录持久化、>20 秒视频过滤、提示词 `@视频文件名` 自动绑定、独立素材库、按需视频预览、状态刷新防重入、起止秒片段审核、裁剪、卡片绑定、任务快照和提交前强制规则审核。Creative Studio 当前前端的 R2V 请求结构、视频/音频共用 Video Uploader、upload/token、bind_videos 和 video_info 链路已接入；真实测试已验证图片 + 视频 + 音频混合参考可创建远端任务，并对超长音频触发的 InvalidParameter 错误增加了提交前拦截。

## 启动

双击：

```text
START_APP.cmd
```

或在项目目录执行：

```text
npm start
```

访问：

```text
http://127.0.0.1:4174
```

要求 Node.js 24 或更高版本。项目使用 Node 内置 `node:sqlite`，无需安装 npm 依赖。

## 使用顺序

1. 上传广告后台 Cookie；
2. 验证 Cookie；
3. 选择视频保存目录；
4. 在图片库、视频库、音频库分别选择素材文件夹，系统递归扫描并按库类型过滤导入；
5. 新增并填写提示词卡，或从“历史提示词”中复用已有任务提示词；
6. 每张卡至少选择 1 张图片，并按需选择最多 3 个视频、3 个音频；视频/音频参考片段超过输出时长或 15 秒上限时先完成片段审核；
7. 设置 4–15 秒输出时长、文件名、重提次数和生成条数；顶部可设置 HTTP 提交并发；
8. 只有“参考审核”与 Provider 校验均通过的卡片才允许提交；未完成卡片继续保留，已提交卡片从输入区移入任务中心；
9. 应用自动获得 taskId、持续轮询并下载视频；
10. 在“结果素材”查看视频。

## Q&A｜网络、Cookie 与常见报错

### Q1：软件需要什么网络环境？

需要能够稳定访问 TikTok Ads / Creative Studio 相关域名，包括 `ads.tiktok.com` 以及生成、上传过程中使用的 TikTok CDN / Upload Host。

Windows 本地使用时，推荐使用 **Clash / Clash Verge** 或其他能够接管 Windows 系统代理的客户端，并优先开启“系统代理（System Proxy）”。软件本身不提供代理节点，也不包含任何代理订阅。

当前程序的代理解析优先级为：

1. 环境变量 `PROXY`；
2. 环境变量 `HTTPS_PROXY`；
3. 环境变量 `HTTP_PROXY`；
4. Electron / Windows 系统代理或 PAC；
5. 默认兜底代理 `http://127.0.0.1:7897`；
6. 无可用代理时使用直连。

如果 Clash / Clash Verge 的端口不是 `7897`，建议直接开启 Windows 系统代理，或者显式配置 `PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`，不要依赖默认端口。

> 建议优先使用 HTTP / Mixed 系统代理。部分请求链路在 Electron 网络失败后会进入 HTTP CONNECT 备用通道，因此不建议只配置纯 SOCKS 环境变量代理。

### Q2：Clash / Clash Verge 推荐怎么设置？

建议按以下顺序检查：

1. 启动 Clash / Clash Verge；
2. 使用你自己的可用代理配置；
3. 开启 **System Proxy / 系统代理**；
4. 确认浏览器可以正常访问 `ads.tiktok.com`；
5. 再启动 Universal HTTP Video Studio；
6. 点击顶部 **“网络诊断”**。

网络诊断会显示：

- 当前网络模式：`environment / system / fallback / direct`；
- 当前代理地址；
- `ads.tiktok.com` 连通性结果。

如果切换节点、代理端口或系统代理状态后软件仍显示旧网络状态，建议关闭并重新启动 App，再执行一次“网络诊断”。

如果诊断结果显示 `DIRECT`，说明当前请求没有经过代理；如果你的本地网络无法直连 TikTok Ads，应先解决代理配置再验证 Cookie 或提交任务。

### Q3：Cookie 从哪里来？怎么导入？

Cookie 必须来自**你自己已经正常登录 `ads.tiktok.com` 的浏览器会话**。普通 TikTok 前台登录 Cookie 不一定包含 Ads / Creative Studio 所需的登录态。

App 支持上传 `.txt` 或 `.json` Cookie 文件，并支持以下常见格式：

- JSON Cookie 数组；
- `{ "cookies": [...] }` 结构；
- Netscape / `cookies.txt` 格式；
- 浏览器请求头形式的 `name=value; name2=value2; ...`。

导入后需要点击 **“验证”**。只有 Cookie 状态为 `valid` 时，提交按钮才会允许正式创建任务。

Cookie 会在本地加密保存。请不要把真实 Cookie 文件、数据库或加密主密钥上传到 GitHub、Issue、网盘公开链接或发送给其他人。

源码模式下以下内容属于敏感运行数据，不应提交到版本库：

```text
storage/data/studio.db
storage/secrets/master.key
storage/secrets/
真实 Cookie 文件
```

### Q4：为什么浏览器已经登录，但 Cookie 还是显示 `Login Required`？

常见原因：

- 导出的不是 `ads.tiktok.com` 登录状态；
- Cookie 已过期；
- Cookie 文件缺少关键登录字段；
- 浏览器重新登录后旧 Cookie 已失效；
- 网络或代理异常导致验证请求没有正常到达 Ads 后台。

处理顺序建议：

1. 先点击“网络诊断”；
2. 确认 `ads.tiktok.com` 连通；
3. 在浏览器中重新打开 Ads / Creative Studio 并确认仍是登录状态；
4. 重新导出完整 Cookie；
5. 删除旧 Cookie Profile 或重新导入；
6. 再点击“验证”。

如果错误内容是 `ECONNRESET / ETIMEDOUT / Proxy CONNECT`，优先处理网络，不要急着重新导出 Cookie。

### Q5：`未识别到有效 Cookie` 是什么问题？

这通常是 Cookie 文件格式问题，而不是账号问题。

请确认：

- 文件不是空文件；
- 使用 `.txt` 或 `.json`；
- JSON 中存在 Cookie 数组；
- Netscape 文件字段完整；
- 请求头形式至少包含 `name=value`；
- 没有把浏览器 Local Storage、请求响应 JSON 或其他非 Cookie 内容误当成 Cookie 导入。

### Q6：`Cookie 内容无法转换为请求头` 怎么处理？

表示文件虽然被读取，但没有得到可用于 TikTok 请求的 Cookie Header。建议重新从已经登录 `ads.tiktok.com` 的浏览器导出完整 Cookie，并优先使用标准 JSON 或 Netscape `cookies.txt` 格式。

### Q7：`ECONNRESET` / `ETIMEDOUT` / `EPIPE` / `Proxy CONNECT` 是什么问题？

这些通常属于**网络、代理或 TLS 链路错误**。

| 报错 | 常见含义 | 建议处理 |
| --- | --- | --- |
| `ECONNRESET` | 连接被远端或中间代理重置 | 换稳定节点，检查 Clash 系统代理，重新执行网络诊断 |
| `ETIMEDOUT` / `timeout` | 请求超时 | 检查节点延迟、代理可用性、网络稳定性 |
| `EPIPE` | 连接过程中通道被关闭 | 重连代理后重试 |
| `Proxy CONNECT failed` | HTTP 代理无法建立 HTTPS CONNECT | 检查代理地址、端口、代理客户端是否启动 |
| `Proxy CONNECT timeout` | 代理端口存在但无法完成连接 | 换节点或检查 Clash 端口 |
| `Invalid HTTP response` | 代理或上游返回了非预期响应 | 检查代理协议、透明代理、网络劫持情况 |
| `ENOTFOUND` | DNS / 域名解析失败 | 检查系统 DNS 与代理 DNS 设置 |

程序对部分临时网络错误会自动重试，但持续出现时应先修复网络环境。

### Q8：`SUBMIT_FAILED` / `提交未返回 taskId` 怎么处理？

表示提交请求已经发出，但没有获得有效的远端生成 `taskId`。

优先检查：

1. Cookie 是否仍然 `valid`；
2. 网络诊断是否正常；
3. Ads / Creative Studio 网页当前是否还能正常使用；
4. 当前 Prompt、参考图、参考视频和参考音频是否符合限制；
5. 先用 1 张图片 + 1 条简单 Prompt + 4–8 秒输出做单任务测试。

不要一开始就开几十条并发来测试 Cookie 或网络状态。

### Q9：`TIKTOK_*_REJECTED` 是什么问题？

这是 TikTok 内容审核返回的拒绝，不属于网络故障。程序会尽量区分具体来源：

- `TIKTOK_TEXT_REJECTED`：提示词文本被拒绝；
- `TIKTOK_PROMPT_REJECTED`：Prompt 被拒绝；
- `TIKTOK_IMAGE_REJECTED`：参考图片被拒绝；
- `TIKTOK_VIDEO_REJECTED`：参考视频被拒绝；
- `TIKTOK_AUDIO_REJECTED`：参考音频被拒绝。

处理方式是修改或替换对应内容后再提交。对于明确的审核拒绝，不建议持续自动重试同一份素材。

### Q10：为什么提示词卡显示无效，提交按钮不可用？

这是本地提交前校验。常见规则包括：

- 至少 1 张参考图片；
- 图片最多 9 张；
- 视频最多 3 个；
- 音频最多 3 个；
- 图片 + 视频 + 音频总数最多 12 个；
- 输出时长为 4–15 秒整数；
- 参考视频总时长不能超过输出时长，也不能超过 15 秒；
- 参考音频总时长不能超过输出时长，也不能超过 15 秒；
- 超长参考视频必须先完成片段审核。

前端卡片的“参考审核”区域会直接显示当前不通过的原因。

### Q11：`InvalidParameter` 怎么处理？

通常表示提交给远端的参数、素材规格或时长不符合当前 Creative Studio 接口要求。先检查：

- 输出时长；
- 参考视频 / 音频总时长；
- 参考文件数量；
- 视频是否已裁剪审核；
- 文件格式和文件大小；
- 是否使用了当前 Provider 不支持的组合。

如果是稳定复现的远端 `InvalidParameter`，建议先降低为最简单的纯图片参考任务验证，再逐个增加视频或音频参考定位问题。

### Q12：`download_failed` 是生成失败吗？

不一定。`download_failed` 表示程序已经进入结果下载阶段，但本地下载没有成功。

如果远端视频 URL 已经取得，通常可以先修复代理或网络，再重新执行下载 / 生命周期检查。不要仅因为下载失败就立即重新生成同一个视频。

### Q13：为什么程序重启后有任务显示未自动重提？

如果任务在“已经发出提交请求、但还没有拿到 taskId”的时间点强制退出，程序会保守处理，避免重启后再次提交导致重复扣量或重复生成。这类情况可能看到类似：

```text
APP_RESTARTED_BEFORE_TASK_ID
```

此时应先去 Creative Studio 后台确认是否已经存在对应任务，再决定是否重新提交。

### Q14：网络和 Cookie 都正常，但还是频繁失败怎么办？

建议按最小化测试法排查：

1. 并发改为 `1`；
2. 每张卡生成数量改为 `1`；
3. 只放 1 张参考图片；
4. Prompt 使用简单描述；
5. 输出 4–8 秒；
6. 提交 1 条测试；
7. 成功后再逐步恢复视频、音频、多卡片和高并发。

这样可以快速判断问题发生在网络、Cookie、素材、Prompt、Provider 参数还是并发层。

## 关键目录

```text
public/                         正式前端
server/                         本地服务与生命周期调度
config/provider-templates/      HTTP 请求模板
storage/data/studio.db          SQLite 数据库
storage/secrets/master.key      Cookie 本地加密主密钥
storage/cache/                  临时缓存和测试缓存
scripts/                        冒烟测试与开发工具
docs/PRD_V1.md                  产品需求文档
docs/STAGE2_IMPLEMENTATION.md   第二阶段实现说明
docs/STAGE3_IMPLEMENTATION.md   第三阶段实现说明
```

`storage/data` 和 `storage/secrets` 不应提交到版本库，也不得发送给其他人。

## 检查

```text
npm run check
node scripts/smoke_stage3.mjs
node scripts/smoke_stage3_lifecycle.mjs
node scripts/smoke_stage3_recovery.mjs
node scripts/smoke_valid_cards_only.mjs
node scripts/smoke_concurrency_generation_mentions.mjs
node scripts/smoke_prompt_mentions.mjs
node scripts/smoke_folder_dialog.mjs
```

上述测试使用本地伪造视频，不会提交真实生成任务，也不会消耗账号额度。

## 当前验证边界

代码层的图片参考提交、轮询和下载链路均已实现。当前未使用真实新任务进行端到端生成测试，因此首次正式使用时建议先提交 1 条 4–15 秒的纯图片参考任务验证当前广告后台接口模板与账号权限。视频/音频远端参考必须等待新的有效 ads.tiktok.com Cookie 完成上传抓包后再开启。