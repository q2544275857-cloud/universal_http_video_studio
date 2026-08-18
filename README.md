# Universal HTTP Video Studio

本地运行的多模态参考视频生成工作台，面向 TikTok Symphony Creative Studio / Seedance 工作流。当前版本：**V0.5.10**。

> 非官方工具。请使用自己的账号、Cookie 与网络环境，并遵守平台规则。

## 主要功能

- **批量 Prompt**：一次粘贴多条 Prompt / Markdown，自动拆成提示词卡。
- **自动识别时长**：从 Prompt 中识别 4–15 秒输出时长。
- **批量生成与命名**：统一设置生成数量，并按前缀 + 序号批量命名。
- **多模态参考**：支持图片、视频、音频；Prompt 中可用 `@素材名` 自动绑定。
- **视频片段裁剪**：按开始 / 结束秒数选择参考片段，FFmpeg 裁剪不修改源文件。
- **并发任务**：支持多卡片、多版本批量提交与任务持久化。
- **自动轮询下载**：获得 taskId 后持续轮询并自动下载成片。
- **失败重试与排查**：临时网络错误可重试，审核拒绝和远端错误会保留原因。
- **历史 Prompt**：搜索、复制、复用历史生成 Prompt。
- **日期导出**：导出当天“视频文件名 + 原始 Prompt”，也可单独导出失败 Prompt。
- **网络诊断**：支持 Windows 系统代理 / PAC / 环境变量代理。
- **Cookie 管理**：Cookie 本地加密保存并验证登录状态。

### 参考素材限制

- 至少 1 张图片
- 图片 ≤ 9
- 视频 ≤ 3
- 音频 ≤ 3
- 总文件数 ≤ 12
- 输出时长 4–15 秒
- 视频 / 音频参考总时长不能超过输出时长，也不能超过 15 秒

## 下载 Windows App

普通用户建议直接从 **Releases** 下载：

- `Universal HTTP Video Studio-x.x.x-Setup.exe`
- `Universal HTTP Video Studio-x.x.x-Portable.exe`

App 已包含运行环境和 FFmpeg，**无需安装 Node.js、npm 或 FFmpeg**。

https://github.com/q2544275857-cloud/universal_http_video_studio/releases

## 从源码运行

### 克隆

```bash
git clone https://github.com/q2544275857-cloud/universal_http_video_studio.git
cd universal_http_video_studio
```

如果 `git clone` 失败，请查看 **[docs/FAQ.md](docs/FAQ.md)**，其中包含 Clash / Clash Verge 与 Git 代理配置。

### Web 模式

要求 Node.js 24+：

```bash
npm start
```

访问：

```text
http://127.0.0.1:4174
```

仅运行 Web 服务时主要使用 Node.js 内置模块；需要视频裁剪时请确保系统可找到 FFmpeg / FFprobe。

### Electron 桌面开发 / 打包

```bash
npm ci
npm run app:dev
```

构建 Windows App：

```bash
npm run dist:win
```

## 基本流程

1. 准备可访问 TikTok Ads / Creative Studio 的网络环境。
2. 导入并验证自己账号的 Ads Cookie。
3. 设置视频输出目录。
4. 导入图片 / 视频 / 音频素材。
5. 新建 Prompt 卡，或批量粘贴 Prompt 自动拆卡。
6. 检查素材、时长、生成数量与文件名。
7. 提交任务。
8. 工作台自动轮询并下载结果。
9. 在任务中心 / 结果素材查看视频与对应 Prompt。

## Q&A / 使用说明

网络、Cookie、Git Clone 和常见报错已独立整理：

### **[docs/FAQ.md](docs/FAQ.md)**

包含：

- Clash / Clash Verge 推荐配置
- `git clone` 失败
- Cookie 导入 / `Login Required`
- `ECONNRESET / ETIMEDOUT / Proxy CONNECT`
- `SUBMIT_FAILED`
- `TIKTOK_*_REJECTED`
- `InvalidParameter`
- `download_failed`
- `APP_RESTARTED_BEFORE_TASK_ID`

## 安全提醒

以下本机数据不要提交到 GitHub 或公开分享：

```text
storage/data/studio.db
storage/secrets/master.key
storage/secrets/
真实 Cookie 文件
```

## 源码检查

```bash
npm run check
```

平台接口、审核规则或登录机制发生变化时，Provider 逻辑可能需要同步更新。
