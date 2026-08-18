# Universal HTTP Video Studio｜FAQ

本页集中说明 GitHub Clone、网络代理、Cookie 与常见报错。

> 软件本身不提供代理节点，也不包含任何代理订阅。请使用你自己的账号、Cookie 与网络环境，并遵守平台规则。

## Q1：`git clone` 失败怎么办？

仓库地址：

```bash
git clone https://github.com/q2544275857-cloud/universal_http_video_studio.git
```

如果浏览器能打开 GitHub，但命令行 `git clone` 失败，通常是 **Git CLI 没有走 Clash / Clash Verge 的代理**。

先确认 Clash / Clash Verge 已启动，并开启 **System Proxy / 系统代理**。

如果 Git 仍无法连接，可以给 Git 显式配置 HTTP 代理。下面以 `7897` 为示例，请替换成你自己的 Clash **HTTP / Mixed Port**：

```bash
git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897
```

然后测试：

```bash
git ls-remote https://github.com/q2544275857-cloud/universal_http_video_studio.git HEAD
```

如果能返回一串 commit hash，再执行：

```bash
git clone https://github.com/q2544275857-cloud/universal_http_video_studio.git
```

不再需要 Git 全局代理时可取消：

```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
```

常见 Clone 报错：

| 报错 | 常见原因 | 建议 |
| --- | --- | --- |
| `Failed to connect to github.com` | Git 未走代理 / 网络不可达 | 开启 Clash 系统代理或给 Git 配置代理 |
| `Recv failure: Connection was reset` | 节点不稳定 / 链路重置 | 换节点后重试 |
| `Could not resolve host: github.com` | DNS 问题 | 检查 Clash DNS / 系统 DNS |
| `SSL_ERROR_SYSCALL` / TLS 错误 | 代理或 TLS 链路异常 | 换节点、检查代理协议 |
| `Repository not found` | URL 错误或仓库权限问题 | 确认仓库 URL；当前仓库为 Public |

---

## Q2：软件需要什么网络环境？

需要能够稳定访问 TikTok Ads / Creative Studio 相关服务，包括：

- `ads.tiktok.com`
- TikTok CDN
- TikTok 上传服务

Windows 本地使用推荐 **Clash / Clash Verge** 或其他可接管 Windows 系统代理的客户端，并优先开启 **System Proxy / 系统代理**。

程序当前代理解析优先级：

1. `PROXY`
2. `HTTPS_PROXY`
3. `HTTP_PROXY`
4. Electron / Windows 系统代理或 PAC
5. 默认兜底 `http://127.0.0.1:7897`
6. 无可用代理时直连

如果你的 Clash 端口不是 `7897`，建议使用系统代理，或显式配置环境变量，不要依赖默认端口。

---

## Q3：Clash / Clash Verge 推荐怎么设置？

建议按下面顺序检查：

1. 启动 Clash / Clash Verge。
2. 选择你自己的可用节点 / 配置。
3. 开启 **System Proxy / 系统代理**。
4. 确认浏览器可以访问 `ads.tiktok.com`。
5. 启动 Universal HTTP Video Studio。
6. 点击顶部 **网络诊断**。

网络诊断会显示：

- 当前网络模式：`environment / system / fallback / direct`
- 当前代理地址
- `ads.tiktok.com` 连通结果

如果显示 `DIRECT`，且你的本地网络不能直连 TikTok Ads，应先解决代理配置。

切换节点、代理端口或系统代理状态后，建议重启 App 再执行一次网络诊断。

---

## Q4：Cookie 从哪里来？怎么导入？

Cookie 必须来自**你自己已经正常登录 `ads.tiktok.com` 的浏览器会话**。

普通 TikTok 前台 Cookie 不一定包含 Ads / Creative Studio 所需登录态。

App 支持 `.txt` / `.json`，常见格式包括：

- JSON Cookie 数组
- `{ "cookies": [...] }`
- Netscape / `cookies.txt`
- `name=value; name2=value2; ...`

导入后点击 **验证**。只有 Cookie 状态为 `valid` 时才能正式提交任务。

Cookie 会在本地加密保存。

以下内容不要上传到 GitHub、Issue 或公开分享：

```text
storage/data/studio.db
storage/secrets/master.key
storage/secrets/
真实 Cookie 文件
```

---

## Q5：为什么浏览器已经登录，但 Cookie 显示 `Login Required`？

常见原因：

- 导出的不是 `ads.tiktok.com` 登录态
- Cookie 已过期
- Cookie 缺少关键字段
- 浏览器重新登录后旧 Cookie 已失效
- 网络 / 代理导致验证请求失败

建议：

1. 先执行网络诊断。
2. 确认 `ads.tiktok.com` 可访问。
3. 浏览器重新打开 Ads / Creative Studio，确认仍处于登录状态。
4. 重新导出完整 Cookie。
5. 重新导入并验证。

如果错误是 `ECONNRESET / ETIMEDOUT / Proxy CONNECT`，优先处理网络，不要先反复换 Cookie。

---

## Q6：`未识别到有效 Cookie` 怎么处理？

通常是 Cookie 文件格式问题。

检查：

- 文件不是空的
- 使用 `.txt` 或 `.json`
- JSON 中确实存在 Cookie 数组
- Netscape 字段完整
- Header 格式至少有 `name=value`
- 没有把 Local Storage、接口 JSON 或其他内容当成 Cookie

---

## Q7：`Cookie 内容无法转换为请求头` 怎么处理？

表示文件被读取，但没有解析出可用于 TikTok 请求的 Cookie Header。

建议重新从已登录 `ads.tiktok.com` 的浏览器导出完整 Cookie，优先使用标准 JSON 或 Netscape `cookies.txt`。

---

## Q8：`ECONNRESET / ETIMEDOUT / EPIPE / Proxy CONNECT` 是什么问题？

这些通常是**网络 / 代理 / TLS 链路问题**。

| 报错 | 含义 | 建议 |
| --- | --- | --- |
| `ECONNRESET` | 连接被远端或中间代理重置 | 换稳定节点，检查 Clash 系统代理 |
| `ETIMEDOUT` / `timeout` | 请求超时 | 检查节点延迟与代理可用性 |
| `EPIPE` | 连接过程中通道关闭 | 重连代理后重试 |
| `Proxy CONNECT failed` | HTTP 代理无法建立 HTTPS CONNECT | 检查代理地址与端口 |
| `Proxy CONNECT timeout` | 代理端口存在但连接不通 | 换节点 / 检查 Clash |
| `Invalid HTTP response` | 上游返回非预期响应 | 检查代理协议与透明代理 |
| `ENOTFOUND` | DNS 解析失败 | 检查系统 / Clash DNS |

程序会自动重试部分临时网络错误，但持续出现时应优先修复网络。

---

## Q9：`SUBMIT_FAILED / 提交未返回 taskId` 怎么处理？

表示请求已发出，但没有获得有效远端 `taskId`。

优先检查：

1. Cookie 是否 `valid`
2. 网络诊断是否正常
3. Creative Studio 网页是否可正常使用
4. Prompt 与参考素材是否符合限制
5. 先用最简单任务测试：1 张图 + 简单 Prompt + 4–8 秒 + 生成 1 条

不要一开始就用几十条并发排查网络或 Cookie。

---

## Q10：`TIKTOK_*_REJECTED` 是什么问题？

这是 TikTok 内容审核拒绝，不属于网络问题。

可能包括：

- `TIKTOK_TEXT_REJECTED`
- `TIKTOK_PROMPT_REJECTED`
- `TIKTOK_IMAGE_REJECTED`
- `TIKTOK_VIDEO_REJECTED`
- `TIKTOK_AUDIO_REJECTED`

应修改或替换对应 Prompt / 图片 / 视频 / 音频后再提交。

明确审核拒绝时，不建议持续自动重试同一份素材。

---

## Q11：为什么提示词卡无效，无法提交？

当前主要规则：

- 至少 1 张参考图片
- 图片最多 9 张
- 视频最多 3 个
- 音频最多 3 个
- 总文件数最多 12 个
- 输出时长 4–15 秒整数
- 参考视频总时长不能超过输出时长，也不能超过 15 秒
- 参考音频总时长不能超过输出时长，也不能超过 15 秒
- 超长参考视频需要先完成片段审核

卡片“参考审核”区域会显示具体原因。

---

## Q12：`InvalidParameter` 怎么处理？

通常表示远端参数、素材规格或时长不符合当前 Creative Studio 接口要求。

检查：

- 输出时长
- 视频 / 音频参考总时长
- 文件数量
- 视频是否完成裁剪审核
- 文件格式 / 大小
- 当前 Provider 是否支持该组合

建议先降级为纯图片参考任务测试，再逐步加入视频或音频定位问题。

---

## Q13：`download_failed` 是生成失败吗？

不一定。

`download_failed` 表示任务已经进入结果下载阶段，但本地下载失败。

如果已经拿到远端视频 URL，优先修复网络 / 代理后重新下载，不要立即重新生成同一条视频。

---

## Q14：`APP_RESTARTED_BEFORE_TASK_ID` 是什么？

如果应用在“提交请求已发出，但 taskId 尚未返回”的时间点退出，程序会保守处理，避免重启后重复提交。

可能看到：

```text
APP_RESTARTED_BEFORE_TASK_ID
```

建议先到 Creative Studio 后台确认是否已经存在对应任务，再决定是否重新提交。

---

## Q15：网络和 Cookie 都正常，但还是频繁失败怎么办？

使用最小化测试法：

1. 并发设为 `1`
2. 每张卡生成数量设为 `1`
3. 只放 1 张参考图片
4. Prompt 使用简单描述
5. 输出 4–8 秒
6. 只提交 1 条
7. 成功后逐步恢复视频、音频、多卡片和高并发

这样可以快速判断问题来自网络、Cookie、素材、Prompt、Provider 参数还是并发层。
