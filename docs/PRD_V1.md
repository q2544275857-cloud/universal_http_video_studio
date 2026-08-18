# Universal HTTP Video Studio V1 PRD

- 文档状态：V1 可开发基线
- 当前阶段：第三阶段已实现（taskId 持久化、持续轮询、视频链接识别、自动下载、重启恢复与结果素材管理）
- 产品形态：Windows 本地 Web App
- 核心入口：图片素材库 + 多提示词卡
- 首版参考媒体：仅图片
- 默认行为：失败不自动重新提交

---

## 1. 背景

现有 Seedance Batch Studio 以 Excel、产品型号、国家账号、产品图库和固定生产计划为中心，适合内部 3C 批量生产，但不适合作为通用视频生成工具。

新项目需要允许普通用户直接上传广告后台 Cookie、选择本地参考图片文件夹并创建多份提示词，通过 HTTP 完成生成任务提交、持续轮询和视频下载。每份提示词必须能够使用自己独立的参考图、时长、输出文件名和失败重提策略。

V1 不复用旧项目的产品字段、国家字段、Excel 主流程和自动提示词改写规则。

---

## 2. 产品目标

### 2.1 核心目标

用户可以在一个页面内完成：

1. 上传并验证一个广告后台 Cookie；
2. 先选择本地图片文件夹，扫描其中的参考图片并建立素材库；
3. 新增任意数量的提示词卡；
4. 为每张提示词卡独立选择参考图；
5. 输入提示词；参考图片由用户在当前卡片中手动选择；输入 `@` 时可从整个素材库指定图片并自动加入当前卡片，但 `@` 不是必填语法；
6. 设置 5–15 秒时长；
7. 设置可选的视频文件名；
8. 设置 0–5 次失败重提次数；
9. 选择本地保存目录；
10. 批量提交全部有效提示词卡；
11. 在获得 taskId 后持续轮询，直到出现视频链接；
12. 自动下载到用户选择的目录；
13. 在任务中心和结果素材管理中查看每份提示词对应的视频与错误原因。

### 2.2 成功标准

V1 上线后，一次标准操作不需要 Excel，不需要填写产品型号，也不需要手动复制 taskId 或视频链接。

任务必须满足：

- 每张提示词卡对应一个独立 GenerationTask；
- 用户输入内容在提交阶段不被静默改写；
- taskId、视频链接、下载路径和错误原因可追溯；
- 应用重启后已提交任务可以恢复轮询；
- 默认失败后不重新提交。

---

## 3. 非目标

V1 明确不做：

- 音频参考；
- 视频参考；
- 文生视频无图模式；
- Excel 导入；
- 产品库、型号库、国家账号库；
- 自动生成或优化提示词；
- 自动删除品牌词或安全词；
- 多图失败后自动降级为单图；
- 自动替换参考图片；
- 视频剪辑、拼接、配音或字幕；
- 多用户账号体系；
- 云端部署与公网访问；
- 手机端完整适配。

---

## 4. 用户角色

### 4.1 本地操作者

主要行为：

- 上传 Cookie；
- 管理参考图片；
- 创建多份提示词；
- 批量生成视频；
- 处理失败任务；
- 管理和下载结果。

V1 为单机单用户，不区分管理员和普通用户。

---

## 5. 核心对象

### 5.1 Cookie Profile

一个广告后台登录身份。保存：

- 名称；
- 加密后的 Cookie 引用；
- 登录验证状态；
- 最近验证时间；
- 提交并发；
- 最大在途任务数；
- 限流或日额度状态。

### 5.2 Asset

系统从用户选择的本地图片文件夹中扫描到的一张图片。保存：

- 原始文件名；
- 用户别名；
- MIME 类型；
- 本地路径；
- 文件大小；
- 宽高；
- SHA-256；
- 缩略图；
- 远端 CDN 缓存信息；
- 被哪些提示词卡引用。

### 5.3 Prompt Card

用户直接编辑的任务配置卡。包含：

1. 图片附件；
2. 提示词输入框；
3. 时长；
4. 视频文件名；
5. 失败后重新提交次数。

### 5.4 Batch Run

一次点击“提交生成”形成的批次快照。

### 5.5 Generation Task

由一张有效 Prompt Card 创建的不可变真实任务。包含提交快照、taskId、轮询结果、视频链接、下载路径和错误记录。

### 5.6 Result Asset

最终下载的视频文件记录。它必须反向关联：

- GenerationTask；
- PromptCard；
- 参考图快照；
- 提示词快照；
- taskId；
- 视频链接；
- 本地下载路径。

---

## 6. 信息架构

V1 使用一个主工作台，包含四个区域：

1. **顶部运行栏**
   - Cookie；
   - 保存目录；
   - 提交按钮；
   - 全局任务统计。

2. **素材管理**
   - 选择或重新选择图片文件夹；
   - 递归扫描支持格式图片；
   - 显示当前文件夹和图片网格；
   - 别名编辑；
   - 引用次数；
   - 删除。

3. **提示词卡工作区**
   - 新增卡片；
   - 复制卡片；
   - 删除卡片；
   - 每卡独立参数。

4. **任务与结果**
   - 任务状态列表；
   - 错误原因；
   - taskId；
   - 视频链接；
   - 下载路径；
   - 视频结果预览。

V1 可在同一页面通过页签切换“任务中心”和“结果素材”。

---

## 7. 主操作流程

### 7.1 正常成功流程

1. 用户上传 Cookie 文件；
2. 用户点击“验证 Cookie”；
3. 系统确认 Cookie 有效；
4. 用户选择视频保存目录；
5. 用户上传至少一张参考图片；
6. 用户新增一张或多张提示词卡；
7. 用户为每张卡选择一张或多张图片；
8. 用户输入提示词；
9. 用户可在提示词中保留普通 `@` 文本，系统不要求其与参考图绑定；
10. 用户选择时长，默认 15 秒；
11. 用户可填写视频文件名；
12. 用户设置失败重提次数，默认 0；
13. 系统完成提交前校验；
14. 用户点击“提交全部有效卡片”；系统只处理校验通过的卡片，未完成卡片继续留在输入区；
15. 系统创建 BatchRun 和 GenerationTask 快照，并将已提交卡片从输入区移入任务中心；
16. 系统上传或复用远端图片；
17. 系统提交任务并获得 taskId；
18. 系统持续轮询；
19. 系统发现视频链接；
20. 系统下载视频；
21. 系统校验文件存在且大小大于 0；
22. 任务进入 COMPLETED；
23. 视频出现在结果素材管理中。

### 7.2 提交失败流程

1. HTTP 提交返回错误；
2. 系统保存状态码、业务 code、message 和脱敏原始响应；
3. 如果 retryLimit = 0，任务立即进入 FAILED_SUBMIT；
4. 如果 retryLimit > 0，按明确的退避策略重新提交；
5. 达到次数后仍失败，进入 FAILED_SUBMIT；
6. 用户可以复制卡片、修改后再创建新任务，不覆盖旧任务。

### 7.3 轮询失败流程

1. 已有 taskId；
2. 轮询返回远端明确失败，则进入 FAILED_REMOTE；
3. 轮询接口暂时异常时，不创建新 taskId，只重试轮询；
4. 默认不设置固定轮询超时，只要远端未明确失败就持续轮询；
5. 用户可以手动触发立即轮询原 taskId，不默认重新生成。

### 7.4 下载失败流程

1. 已拿到视频链接；
2. 下载失败进入 FAILED_DOWNLOAD；
3. 保留视频链接；
4. 用户可点击“重新下载”；
5. 重新下载不得重新提交生成任务。

---

## 8. 功能需求

## 8.1 顶部运行栏

### FR-TOP-001 Cookie 上传

用户可上传广告后台 Cookie 文件。

要求：

- 仅接受允许的文本或 JSON Cookie 格式；
- 文件内容不回显；
- 上传后显示文件名和“待验证”；
- Cookie 不写入前端 LocalStorage；
- Cookie 内容不写入普通日志。

### FR-TOP-002 Cookie 验证

用户必须在提交前完成 Cookie 验证。

状态：

- 未上传；
- 待验证；
- 验证中；
- 有效；
- 已失效；
- 限流；
- 日额度用尽；
- 验证失败。

### FR-TOP-003 保存目录

用户必须在提交前选择本地保存目录。

要求：

- 正式 Windows 版本使用资源管理器风格的现代文件选择窗口选定目录，不使用旧树状 FolderBrowserDialog；
- Web 原型可使用 File System Access API；
- 后端实际保存时必须验证目录可写；
- 保存目录属于 BatchRun 快照；
- 批次开始后更改全局目录不影响已创建任务。

### FR-TOP-004 提交按钮

按钮文案：`提交全部有效卡片`。

按钮启用条件：

- Cookie 有效；
- 已选择保存目录；
- 至少有一张通过校验的 Prompt Card。

未完成卡片不阻塞其他有效卡片提交。提交成功后，有效卡片从输入区移除并进入任务中心；无效卡片继续保留。

---

## 8.2 素材管理

### FR-ASSET-001 选择图片文件夹

用户不逐张上传图片，而是选择一个本地图片文件夹。系统扫描该文件夹及其子文件夹中的支持格式图片并建立本次素材库。

支持：

- PNG；
- JPG；
- JPEG；
- WEBP。

暂不支持：

- GIF；
- SVG；
- MP4；
- MOV；
- MP3；
- WAV。

扫描结果需保留相对路径，用于区分不同子文件夹中的同名文件。只读取图片，不修改或移动源文件。

### FR-ASSET-002 选择顺序约束

用户必须先选择图片文件夹并完成扫描，才能在 Prompt Card 中选择图片。

Prompt Card 内不提供独立文件上传控件，只提供“从素材库选择”。

### FR-ASSET-003 去重

按 SHA-256 内容哈希去重。

- 同一文件夹内内容相同的图片只建立一份 Asset 记录；
- 重新扫描时复用已有哈希和远端缓存；
- 不复制或改写用户源文件。

### FR-ASSET-004 素材别名

用户可修改素材显示别名。

别名用途：

- Prompt Card 附件标签；
- 素材搜索；
- 任务快照显示。

别名需规范化：空格转下划线，过滤路径符号和常见标点；允许中文、英文、数字、连字符和下划线。别名不是远端文件名，不影响哈希。

### FR-ASSET-005 从本次素材库移除

未被引用时可以从本次素材库索引中移除，但不得删除磁盘中的源文件。

已被 Prompt Card 引用时：

- 禁止直接移除；
- 显示引用卡片；
- 用户必须先从相关卡片解除引用。

已创建 GenerationTask 的快照不因素材库索引变化而变化。

### FR-ASSET-006 重新选择文件夹

重新选择文件夹时，新扫描结果替换当前素材库。

- 如果当前素材被 Prompt Card 引用，必须明确提示影响并要求确认；
- 确认后解除卡片的旧 assetId 绑定；
- 用户提示词原文不得被静默删除或重写；
- 旧图片绑定解除后，卡片因缺少参考图而无法提交，但提示词中的普通 `@` 文本不触发额外绑定错误；
- 不删除旧文件夹中的任何源文件。

### FR-ASSET-007 远端缓存

同一图片在同一 Provider 和 Cookie Profile 下，优先复用有效 CDN 资源。

缓存键至少包含：

- asset SHA-256；
- provider key；
- cookie profile id；
- 远端资源有效期信息。

---

## 8.3 Prompt Card

### FR-CARD-001 新增卡片

点击“新增提示词卡”后创建空卡：

- 图片附件：空；
- 提示词：空；
- 时长：15 秒；
- 视频文件名：空；
- 失败重提次数：0。

### FR-CARD-002 多卡独立性

每张卡的参考图片完全独立。

系统不得：

- 自动继承上一卡图片；
- 强制复用上一卡图片；
- 根据文件名自动替换；
- 因卡片复制之外的操作同步修改其他卡。

### FR-CARD-003 选择图片附件

用户从素材库多选图片。

要求：

- 至少 1 张；
- V1 最大 8 张；
- 支持排序；
- 排序决定媒体索引；
- 从卡中移除只解除引用，不删除素材库文件。

### FR-CARD-004 提示词输入

必填，多行文本。

系统仅保存用户原文，不自动优化、翻译或安全改写。

### FR-CARD-005 参考图与提示词关系

- 参考图片由用户在当前 Prompt Card 中手动选择；
- 所选图片随任务请求的图片数组和 mentions 字段提交；
- 提示词不要求出现 `@`、素材别名或媒体编号；
- 提示词中的普通 `@` 文本允许原样保存，不作为提交校验条件；
- 系统可在内部兼容旧版 `@素材别名` 编译，但不在输入界面展示编译预览或媒体索引；
- 是否使用某张参考图，以卡片中的手动选择结果为准。

### FR-CARD-006 时长

- 必填；
- 最小 5 秒；
- 最大 15 秒；
- 默认 15 秒；
- 只允许整数。

### FR-CARD-007 视频文件名

可选。

如果填写：

- 自动移除 `.mp4` 后缀后再规范化；
- 过滤 Windows 非法字符 `\\ / : * ? " < > |`；
- 去除首尾空格和句点；
- 不允许结果为空；
- 最长建议 120 字符。

如果不填写，系统生成：

```text
video_YYYYMMDD_HHmmss_卡片序号
```

冲突策略：

```text
name.mp4
name_2.mp4
name_3.mp4
```

不得覆盖既有文件，除非用户在后续版本显式启用覆盖。

### FR-CARD-008 失败后重新提交次数

- 最小 0；
- 最大 5；
- 默认 0；
- 仅整数。

含义：首次提交失败后最多再创建多少次 HTTP 提交尝试。

该设置不应用于：

- 普通轮询接口临时异常；
- 视频下载失败。

轮询和下载有各自重试机制，但不得创建新 taskId。

### FR-CARD-009 复制卡片

复制以下内容：

- 图片选择和顺序；
- 提示词；
- Mention 绑定；
- 时长；
- 重试次数。

视频文件名默认追加 `_copy` 或留空，避免冲突。

### FR-CARD-010 删除卡片

- 草稿卡可直接删除；
- 已创建任务的卡片可以从当前编辑区移除，但历史 GenerationTask 不删除；
- 删除需二次确认。

---

## 8.4 提交校验

### FR-VALIDATE-001 全局校验

阻断条件：

- Cookie 未上传或未验证；
- 保存目录未选择或不可写；
- 没有 Prompt Card。

### FR-VALIDATE-002 卡片校验

每张卡必须满足：

- 至少选择 1 张参考图；
- 提示词非空；
- 时长为 5–15 整数；
- 重试次数为 0–5 整数；
- 所有 Mention 已解析；
- 文件名合法。

### FR-VALIDATE-003 错误定位

提交失败校验时：

- 顶部显示错误数量；
- 自动滚动到第一张错误卡；
- 卡片边框标红；
- 字段下显示具体错误；
- 不使用笼统的“参数错误”。

---

## 8.5 批次与任务

### FR-BATCH-001 创建快照

提交时创建不可变快照，包括：

- Cookie Profile ID；
- 保存目录；
- 图片 assetId 和顺序；
- 本地图片哈希；
- 原始提示词；
- 编译提示词；
- Mention 映射；
- 时长；
- 最终文件名；
- 重试上限。

编辑原卡片不得影响已创建任务。

### FR-BATCH-002 一卡一任务

V1 每张 Prompt Card 创建一个 GenerationTask。

不包含“每卡生成多份”字段。未来如重新加入复制份数，应由任务展开层实现，不改变 Prompt Card 的基础结构。

### FR-TASK-001 提交

流程：

1. 上传或读取远端图片缓存；
2. 按图片顺序构建 URL 数组；
3. 编译 `<|media:n|>`；
4. 调用 Provider 提交；
5. 解析 taskId；
6. 保存脱敏响应。

没有 taskId 视为提交失败。

### FR-TASK-002 默认不重提

retryLimit = 0 时，任何提交错误立即结束，不进行第二次提交。

### FR-TASK-003 重提

retryLimit > 0 时：

- 仅对被分类为可重试的提交错误执行；
- 每次尝试记录时间、错误和响应；
- 不改写提示词；
- 不删除参考图；
- 不改变图片顺序；
- 不改变时长；
- 不改变文件名。

建议退避：30 秒、60 秒、120 秒、240 秒、480 秒。

日额度用尽、Cookie 失效和明确内容拒绝默认不自动重提，即使 retryLimit > 0，也应进入阻断状态并显示原因。

---

## 8.6 轮询

### FR-POLL-001 持续轮询

成功拿到 taskId 后，系统必须持续轮询，直到：

- 得到可下载视频链接；
- 远端任务明确失败；
- 用户明确停止或取消。

默认不设置固定最大轮询时长，任务可以跨应用重启持续等待视频链接。

### FR-POLL-002 轮询间隔

默认 45 秒，可作为系统设置，不在每张卡暴露。

### FR-POLL-003 恢复

应用重启后：

- `SUBMITTED` 和 `POLLING` 任务自动恢复轮询；
- 不重新提交；
- 沿用原 taskId。

### FR-POLL-004 视频链接识别

轮询响应中可能存在多个 URL。Provider Adapter 负责：

- 识别真实 MP4/视频资源；
- 排除封面图和图片模板 URL；
- 对候选链接评分；
- 保存最终选用链接和候选摘要。

---

## 8.7 下载

### FR-DOWNLOAD-001 自动下载

拿到视频链接后立即下载到 BatchRun 保存目录。

### FR-DOWNLOAD-002 下载验证

完成条件：

- 文件存在；
- 文件大小大于 0；
- 可选使用 ffprobe 验证为视频；
- 数据库记录最终路径。

### FR-DOWNLOAD-003 下载失败

- 状态为 FAILED_DOWNLOAD；
- 保留视频链接；
- 提供“重新下载”；
- 不创建新 taskId。

### FR-DOWNLOAD-004 打开目录

完成后支持：

- 打开文件；
- 打开所在目录；
- 复制本地路径；
- 复制视频链接。

---

## 8.8 任务中心

任务列表字段：

- 任务序号；
- 来源卡片；
- 文件名；
- 参考图缩略图；
- 时长；
- 状态；
- taskId；
- 提交尝试次数；
- 最近轮询时间；
- 视频链接；
- 下载路径；
- 错误摘要；
- 操作。

筛选：

- 全部；
- 运行中；
- 已完成；
- 提交失败；
- 远端失败；
- 下载失败。

---

## 8.9 结果素材管理

每条结果卡必须显示：

- 视频文件名；
- 对应 Prompt Card；
- 参考图缩略图；
- 时长；
- taskId；
- 视频链接；
- 本地保存路径；
- 完成时间；
- 提示词快照。

支持：

- 播放本地视频；
- 打开文件；
- 打开目录；
- 复制链接；
- 查看完整任务详情。

失败任务也应保留在任务中心，但不进入“已完成结果”列表。

---

## 9. 状态机

```text
DRAFT
  ↓
VALIDATING
  ├─ BLOCKED_VALIDATION
  ↓
READY
  ↓
UPLOADING_MEDIA
  ├─ FAILED_UPLOAD
  ↓
SUBMITTING
  ├─ RETRY_WAIT
  ├─ BLOCKED_AUTH
  ├─ RATE_LIMITED
  ├─ DAILY_LIMITED
  ├─ REJECTED_CONTENT
  └─ FAILED_SUBMIT
  ↓
SUBMITTED
  ↓
POLLING
  ├─ FAILED_REMOTE
  ├─ FAILED_POLL_TIMEOUT
  └─ CANCELLED
  ↓
VIDEO_READY
  ↓
DOWNLOADING
  ├─ FAILED_DOWNLOAD
  ↓
VERIFYING_OUTPUT
  ↓
COMPLETED
```

---

## 10. 错误分类

### 10.1 校验错误

- `COOKIE_REQUIRED`
- `COOKIE_NOT_VALID`
- `SAVE_DIR_REQUIRED`
- `SAVE_DIR_NOT_WRITABLE`
- `ASSET_REQUIRED`
- `PROMPT_REQUIRED`
- `DURATION_INVALID`
- `FILENAME_INVALID`
- `RETRY_LIMIT_INVALID`
- `MENTION_UNRESOLVED`

### 10.2 上传错误

- `ASSET_FILE_MISSING`
- `ASSET_FORMAT_UNSUPPORTED`
- `REMOTE_UPLOAD_TOKEN_FAILED`
- `REMOTE_UPLOAD_FAILED`
- `REMOTE_COMMIT_FAILED`

### 10.3 提交错误

- `COOKIE_EXPIRED`
- `CSRF_INVALID`
- `RATE_LIMIT_5MIN`
- `DAILY_LIMIT`
- `CONTENT_REJECTED`
- `COPYRIGHT_REJECTED`
- `TASK_ID_MISSING`
- `REMOTE_HTTP_ERROR`

### 10.4 轮询错误

- `REMOTE_TASK_FAILED`
- `POLL_HTTP_ERROR`
- `POLL_TIMEOUT`
- `VIDEO_URL_MISSING`

### 10.5 下载错误

- `DOWNLOAD_HTTP_ERROR`
- `OUTPUT_DIR_ERROR`
- `OUTPUT_FILE_EMPTY`
- `OUTPUT_VERIFY_FAILED`

用户界面显示本地化错误摘要，同时允许展开技术详情。Cookie、CSRF、Authorization 和完整请求头必须脱敏。

---

## 11. 数据模型建议

### 11.1 assets

```sql
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  original_name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 11.2 cookie_profiles

```sql
CREATE TABLE cookie_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  last_validated_at TEXT,
  submit_concurrency INTEGER NOT NULL DEFAULT 1,
  max_inflight INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 11.3 prompt_cards

```sql
CREATE TABLE prompt_cards (
  id TEXT PRIMARY KEY,
  title TEXT,
  prompt_raw TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 15,
  output_filename TEXT,
  retry_limit INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 11.4 prompt_card_assets

```sql
CREATE TABLE prompt_card_assets (
  prompt_card_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (prompt_card_id, asset_id)
);
```

### 11.5 prompt_mentions

```sql
CREATE TABLE prompt_mentions (
  id TEXT PRIMARY KEY,
  prompt_card_id TEXT NOT NULL,
  asset_id TEXT,
  display_text TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  status TEXT NOT NULL
);
```

### 11.6 batch_runs

```sql
CREATE TABLE batch_runs (
  id TEXT PRIMARY KEY,
  cookie_profile_id TEXT NOT NULL,
  save_dir TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 11.7 generation_tasks

```sql
CREATE TABLE generation_tasks (
  id TEXT PRIMARY KEY,
  batch_run_id TEXT NOT NULL,
  source_prompt_card_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_task_id TEXT,
  retry_limit INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  video_url TEXT,
  download_path TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

### 11.8 task_attempts

记录每次上传、提交、轮询和下载尝试，响应必须脱敏。

---

## 12. 安全与隐私

- 服务默认仅监听 `127.0.0.1`；
- Cookie 使用本机加密存储；
- 前端不持久化 Cookie 内容；
- 日志禁止输出 Cookie、CSRF、Authorization 和上传临时密钥；
- 诊断包只包含脱敏摘要；
- 用户删除 Cookie Profile 时同步删除本地 Secret；
- 不将素材或结果上传到项目无关的第三方服务；
- HTTP Provider 必须明确标注为用户授权账号下的本地自动化能力。

---

## 13. 非功能需求

### 13.1 可恢复性

- SQLite 使用 WAL；
- 每次状态变更立即落库；
- 重启后恢复 SUBMITTED、POLLING、VIDEO_READY、DOWNLOADING 状态；
- 已有 taskId 的任务不得重复提交。

### 13.2 性能

- 文件夹扫描 500 张图片时仍可正常筛选；
- 单批建议支持至少 50 张 Prompt Card；
- 文件夹扫描和缩略图处理不阻塞主界面；
- 任务状态通过 SSE 推送，不依赖高频全量刷新。

### 13.3 可观测性

每个任务应记录：

- 状态变更；
- Provider；
- 提交尝试；
- taskId；
- 轮询次数；
- 下载尝试；
- 错误分类；
- 时间戳。

---

## 14. App 原型说明

交互原型位于：

```text
prototype/index.html
```

原型用于确认：

- 页面信息密度；
- 素材库与卡片之间的关系；
- 每卡独立选图；
- `@` 引用交互；
- 提交前校验；
- 任务和结果的对应关系；
- 错误状态展示。

原型使用模拟 taskId 和模拟状态推进，不调用任何真实远端接口。

---

## 15. V1 验收标准

### AC-001 素材先行

没有选择图片文件夹或扫描结果为空时，Prompt Card 无法选图；卡片内不存在本地临时上传入口。

### AC-002 多卡独立选图

创建三张卡，可分别选择不同图片，修改其中一张不影响其他卡。

### AC-003 必填校验

缺少图片、提示词或有效时长时，无法提交，并明确定位错误卡和字段。

### AC-004 参考图手动选择

用户手动选择的图片随当前卡任务提交。提示词可包含或不包含 `@`；未绑定的普通 `@` 文本不阻止提交，界面不展示内部媒体索引或编译预览。

### AC-005 时长边界

4 秒和 16 秒被拒绝，5 秒和 15 秒通过，默认值为 15 秒。

### AC-006 文件名

文件名为空时自动生成；存在非法字符时提示或规范化；已有同名文件时不覆盖。

### AC-007 重提默认值

新卡默认重提次数为 0。提交失败后不产生第二次提交。

### AC-008 taskId 后持续轮询

任务获得 taskId 后进入 POLLING，直到发现视频链接或进入终态。

### AC-009 下载

发现视频链接后自动下载到批次保存目录；下载失败只重试下载，不重新生成。

### AC-010 结果对应

每个完成视频可以查看其来源卡片、参考图、提示词、时长、taskId 和保存路径。

### AC-011 重启恢复

程序重启后，有 taskId 的未完成任务继续轮询，不重复提交。

### AC-012 不静默改稿

数据库中的 promptCompiled 仅允许为兼容旧版素材别名进行内部媒体 token 替换；不得改变用户原文语义，也不得在输入界面直接展示。

---

## 16. 建议开发阶段

### Stage 1：前端和本地数据层

- App 页面；
- 图片文件夹选择、扫描与缩略图；
- Prompt Card CRUD；
- 手动参考图选择；
- 提交校验；
- SQLite 表结构；
- 模拟任务状态。

### Stage 2：真实图片与 Cookie 链路

- Cookie Vault；
- Cookie 校验；
- 图片 HTTP 上传；
- CDN 缓存；
- 真实任务提交；
- taskId 落库。

### Stage 3：轮询和下载（已实现）

- 按 Cookie 合并持续轮询；
- 应用重启恢复；
- 视频 URL 识别与候选评分；
- 自动下载与格式校验；
- SHA-256 和结果素材入库；
- 本地视频预览、打开目录和复制链接；
- 轮询、远端生成和下载错误诊断。

---

## 17. 已锁定产品决策

1. V1 仅支持图片参考；
2. 用户必须先选择图片文件夹并完成素材扫描；
3. 每张提示词卡独立选择参考图；
4. 卡片内不直接上传临时图片；
5. 卡片字段固定为图片附件、提示词、时长、视频文件名、失败重提次数；
6. 时长为 5–15 秒，默认 15 秒；
7. 重提次数为 0–5，默认 0；
8. 默认提交失败不自动重提；
9. 获得 taskId 后必须持续轮询；
10. 出现视频链接后自动下载；
11. 用户自主选择保存目录；
12. 每份提示词和视频结果必须一一对应；
13. 不使用 Excel；
14. 不依赖产品或品类；
15. 不静默修改用户提示词。