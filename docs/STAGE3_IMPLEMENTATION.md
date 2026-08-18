# Universal HTTP Video Studio｜第三阶段实现说明

- 版本：0.3.1
- 阶段目标：从已持久化 taskId 开始，持续轮询、发现视频链接、自动下载、重启恢复并建立结果素材管理。
- 当前状态：代码完成，本地模拟链路验证通过；未创建真实远端生成任务。

---

## 0. V0.3.1 输入区行为修订

- 参考图完全以用户在 Prompt Card 中的手动选择为准；
- 提示词中的 `@` 不再是强制绑定语法，也不再触发未绑定错误；
- 输入界面隐藏内部媒体索引和编译预览；
- 多卡提交时只提交有效卡片，未完成卡片继续保留；
- 有效卡片创建 GenerationTask 后归档，不再显示在输入区；
- `START_APP.cmd` 检测到本应用已运行时只打开页面，避免重复启动导致 `EADDRINUSE`。

## 1. 已完成范围

### 1.1 持续轮询

应用启动后自动运行生命周期调度器。

轮询对象：

- `submitted`
- `polling`

行为：

1. 按 Cookie Profile 对待轮询任务分组；
2. 同一个 Cookie 的多个 taskId 共用一次历史任务请求；
3. 从 `history/tasks` 返回结果中匹配 taskId；
4. 解析远端状态、错误信息和视频 URL；
5. 未出现链接时继续轮询；
6. 临时网络错误采用退避间隔，但不把任务设为终态；
7. 明确远端失败时进入 `remote_failed`；
8. 出现视频链接时进入 `video_ready`。

默认轮询间隔为 45 秒。调度器每 5 秒检查一次是否存在到期任务，不会每 5 秒请求远端。

没有设置固定 90 分钟超时。只要远端未明确失败，任务会跨应用重启持续轮询。

### 1.2 视频链接识别

系统递归检查历史任务结果中的 URL，并过滤封面、图片和非视频资源。

候选链接按照以下信号评分：

- `mime_type=video_mp4`
- `.mp4`
- `v16-ad-creative`
- `v19-ad-creative`
- TikTok 视频存储路径
- URL 中可见码率参数

所有候选链接会写入 `video_urls_json`，首选链接写入 `video_url`。

### 1.3 自动下载

进入 `video_ready` 后自动下载。

下载流程：

1. 使用候选链接评分顺序逐个尝试；
2. 使用 `.part` 临时文件；
3. 跟随重定向；
4. 支持代理；
5. 自动进行网络重试；
6. 下载后检查文件大小；
7. 检查 MP4 `ftyp` 或 WebM 文件头；
8. 排除 JSON、HTML 错误页；
9. 计算 SHA-256；
10. 原子重命名为最终文件；
11. 写入 `result_assets`。

文件名冲突时不会覆盖已有文件，而是使用：

```text
video.mp4
video (1).mp4
video (2).mp4
```

默认允许 3 次自动重新下载。下载失败不会重新提交生成任务。

### 1.4 重启恢复

应用启动时执行以下恢复：

| 中断前状态 | 恢复状态 |
| --- | --- |
| `submitted` | `polling` |
| `polling` | `polling` |
| `video_ready` | `video_ready` |
| `downloading` | `video_ready` |
| `download_retry` | `video_ready` |
| `completed` 且文件存在 | `completed` |
| `completed` 但文件丢失或损坏 | `download_failed` |

已有 taskId 的任务不会再次提交。

应用在获得 taskId 之前退出时，仍沿用第二阶段的防重复策略：标记 `APP_RESTARTED_BEFORE_TASK_ID`，不自动重提。

### 1.5 结果素材管理

结果页面提供：

- 本地视频预览；
- HTTP Range 视频流；
- 文件名；
- 时长；
- 文件大小；
- 本地路径；
- 打开 Explorer 并选中文件；
- 复制视频链接；
- 查看来源任务详情。

每个结果反向关联：

- Generation Task
- Prompt Card
- 原始提示词
- 编译提示词
- taskId
- 视频 URL
- 本地路径
- SHA-256

---

## 2. 新增任务状态

```text
submitted
→ polling
→ video_ready
→ downloading
→ completed
```

下载重试：

```text
downloading
→ download_retry
→ downloading
```

终态失败：

```text
remote_failed
download_failed
```

提交阶段状态仍保留：

```text
queued
uploading_media
submitting
retry_wait
submit_failed
```

---

## 3. SQLite 变更

`generation_tasks` 新增：

- `remote_status`
- `remote_poll_json`
- `poll_count`
- `poll_error_count`
- `next_poll_at`
- `last_polled_at`
- `video_url`
- `video_urls_json`
- `download_path`
- `download_attempts`
- `download_error`
- `downloaded_at`
- `completed_at`
- `result_metadata_json`

新增 `result_assets` 表：

- `task_id`
- `video_url`
- `local_path`
- `byte_size`
- `sha256`
- `metadata_json`

数据库启动时自动迁移，不需要手工执行 SQL。

---

## 4. 新增 API

### 立即执行生命周期检查

```text
POST /api/lifecycle/run
```

### 立即轮询单个任务

```text
POST /api/tasks/:id/poll-now
```

### 重新下载

```text
POST /api/tasks/:id/retry-download
```

### 打开本地文件

```text
POST /api/tasks/:id/open
```

### 视频预览流

```text
GET /api/tasks/:id/video
```

视频接口支持 `Range` 请求。

---

## 5. 新增模块

```text
server/lifecycleService.js
server/downloadService.js
```

Provider 新增：

- 历史任务分页读取；
- taskId 匹配；
- 远端结果摘要；
- 视频 URL 收集和评分；
- 远端错误解析。

---

## 6. 验证结果

### 6.1 语法检查

```text
npm run check
```

通过。

### 6.2 链接识别和文件下载

```text
node scripts/smoke_stage3.mjs
```

验证：

- 远端结果识别为 `video_ready`；
- 视频链接提取；
- curl 下载；
- MP4 文件头校验；
- SHA-256。

通过。

### 6.3 生命周期入库

```text
node scripts/smoke_stage3_lifecycle.mjs
```

验证：

- `video_ready` 自动进入下载；
- 下载完成后状态为 `completed`；
- `result_assets` 成功写入；
- 本地结果文件存在。

通过。

### 6.4 重启恢复

```text
node scripts/smoke_stage3_recovery.mjs
```

验证：

- `submitted → polling`；
- `downloading → video_ready`；
- 完成记录文件缺失时变为 `download_failed`。

通过。

### 6.5 浏览器检查

验证：

- 第三阶段页面加载；
- 调度器状态显示；
- 任务中心状态；
- 结果页；
- 视频 Range 返回 `206 Partial Content`；
- 页面控制台 0 个错误。

通过。

---

## 7. 未执行的真实外部验证

本阶段没有创建真实远端任务，也没有消耗生成额度。

以下内容仍需使用一条真实小任务确认：

1. 当前 Cookie 对 `history/tasks` 的访问权限；
2. 2026-06-30 捕获的请求模板是否仍兼容；
3. 当前远端结果中的视频 URL 字段是否仍符合已实现的识别规则；
4. 真实视频 CDN 是否需要额外 Header 或代理配置。

建议首轮只提交 1 条任务进行端到端验证。