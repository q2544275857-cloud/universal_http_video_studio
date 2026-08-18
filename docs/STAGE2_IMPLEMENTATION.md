# 第二阶段实现说明

## 1. 范围

第二阶段将第一阶段静态原型升级为可运行的 Windows 本地应用，完成从本地配置到获得远端 taskId 的链路。

本阶段包含：

1. 本地 SQLite 数据层；
2. Windows 原生目录选择；
3. 图片文件夹递归扫描与索引；
4. Prompt Card 持久化；
5. Cookie 本地加密存储；
6. Cookie 有效性验证；
7. 图片 HTTP 上传和 CDN 缓存；
8. Prompt Mention 编译；
9. HTTP 生成提交；
10. taskId 持久化；
11. 提交失败原因和用户配置重提；
12. SSE 状态推送。

本阶段不轮询视频结果，也不下载视频。

---

## 2. 运行架构

```text
Browser UI (127.0.0.1:4174)
        │
        ├── JSON API
        ├── SSE task events
        └── image preview
              │
Node local server
        ├── Windows folder dialog
        ├── SQLite (node:sqlite)
        ├── AES-256-GCM Cookie Vault
        ├── Image folder indexer
        ├── Prompt Card service
        ├── Persistent task queue
        └── Creative Studio HTTP Provider
              ├── Cookie validate
              ├── upload token
              ├── ApplyImageUpload
              ├── TOS bytes upload
              ├── CommitImageUpload
              └── gen_r2v_video
```

---

## 3. 关键目录

```text
server/
  index.js
  db.js
  assets.js
  cookieService.js
  taskService.js
  vault.js
  windowsDialog.js
  provider/
    httpRequest.js
    creativeStudioI2V.js

public/
  index.html
  app.js
  styles.css

config/provider-templates/
  creative_studio_i2v.json

storage/
  data/studio.db
  secrets/master.key
  cache/
  logs/
```

`storage` 在首次启动时自动创建。

---

## 4. 数据状态

第二阶段任务状态：

```text
queued
→ uploading_media
→ submitting
→ submitted
```

失败路径：

```text
uploading_media / submitting
→ retry_wait（仅 retry_limit > 0）
→ submit_failed
```

默认 `retry_limit = 0`，所以默认失败后直接进入 `submit_failed`。

应用在尚未获得 taskId 时退出，重启后不会自动重复提交，而会标记：

```text
APP_RESTARTED_BEFORE_TASK_ID
```

目的是避免远端实际已接收请求、但本地未收到响应时发生重复生成。

---

## 5. 提交快照

点击提交时，每张 Prompt Card 创建不可变任务快照：

- 图片 asset ID 顺序；
- 原始提示词；
- 编译提示词；
- 时长；
- 文件名；
- 重提上限；
- Cookie Profile；
- 保存目录。

卡片后续修改不会改变已经创建的任务。

---

## 6. Cookie 安全

Cookie 文件通过浏览器读取后，仅发送到本机 `127.0.0.1` 服务。

服务端处理：

1. 解析 Cookie 格式；
2. 使用本地主密钥执行 AES-256-GCM 加密；
3. 将密文保存到 SQLite；
4. 请求时临时解密；
5. 不把 Cookie、CSRF、Authorization 写入日志。

本地主密钥：

```text
storage/secrets/master.key
```

删除该密钥后，既有 Cookie 密文将无法解密。

---

## 7. 图片缓存

远端图片缓存键：

```text
asset.sha256 + cookie_profile_id + provider_key
```

同一图片在同一 Cookie 和 Provider 下再次使用时，优先复用 CDN URL，不重新上传。

切换 Cookie 后会建立独立缓存，避免不同登录身份之间混用远端资源。

---

## 8. Provider 风险边界

当前 Provider 模板来自 2026-06-30 的已验证抓包结构。

远端页面或接口可能变化。应用顶部显示模板捕获日期，出现以下错误时应重新抓包：

- 请求字段变化；
- model ID 变化；
- settings 结构变化；
- 上传签名变化；
- 接口 URL 变化；
- 返回值不再包含 taskId。

系统不会在提交失败时自动改写用户提示词，也不会自动删除参考图。

---

## 9. 第三阶段接口预留

`generation_tasks.remote_task_id` 已持久化。第三阶段将以此为唯一轮询依据，增加：

- history/tasks 轮询器；
- poll_count；
- next_poll_at；
- video_url；
- download_path；
- downloaded_at；
- 轮询恢复；
- 下载恢复；
- 结果素材页。
