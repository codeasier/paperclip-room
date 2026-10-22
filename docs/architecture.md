# 架构与接口

[返回使用文档](../README.md)

## 数据流

```text
Browser (index.html)
    │ same-origin HTTP /api/*
    ▼
Python ThreadingHTTPServer (server.py)
    ├── Bearer token file → Paperclip REST API
    └── read-only SQLite → Hermes state.db
```

无第三方 Python 依赖、前端打包器或应用数据库。密钥由后端从文件读取，不提供给浏览器。短时 TTL 缓存减少重复 API 请求；控制台不修改 Hermes 数据库。

## 本项目 HTTP 接口

这些是控制台的代理接口，不是 Paperclip 原生接口。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/`、`/index.html` | 静态页面，按请求读盘 |
| GET | `/api/teams` | 当前 token 可见的 active 团队（Paperclip 公司），含默认团队标记 |
| GET | `/api/state?company=<id>` | 指定团队成员、当前任务、活跃运行与模型快照 |
| GET | `/api/tasks?company=<id>&agent=<id>` | 成员名下未结/最近完成任务，以及最近参与或被点名的其他任务；含检查项、运行与讨论摘要 |
| GET | `/api/room?company=<id>&agent=<id>` | 成员相关任务、评论与精确运行回执 |
| GET | `/api/execution?company=<id>&agent=<id>` | 当前成员最近4次运行及最新过程页 |
| GET | `/api/run?company=<id>&agent=<id>&run=<uuid>&before=<cursor>` | 指定运行的更早过程页；校验团队与成员归属 |
| POST | `/api/send?company=<id>` | JSON `{ "agentId": "…", "text": "…" }`；追加评论或新建任务 |
| POST | `/api/model` | JSON `{ "agentId": "…", "model": "…" }`；修改 adapterConfig.model |

除 `/api/teams` 外，所有团队相关接口都接受 `company` 参数；省略时回落到 `PAPERCLIP_COMPANY`。服务端只接受当前 token 可见且 active 的公司 ID，缓存按公司隔离。响应使用 JSON 和 `Cache-Control: no-store`。没有 SSE/WebSocket；状态5秒轮询，任务进展、评论和过程8秒轮询，标签页进入后台时暂停。环境配置在进程启动时读取。

## Paperclip 接口依赖

后端使用公司的 agents、issues、heartbeat-runs 列表、任务 comments、单个 heartbeat run，以及成员模型 PATCH 等接口。API 根路径由 `PAPERCLIP_BASE` 追加 `/api/...` 形成。不同 Paperclip 版本或 token 权限可能影响字段和可用性，应以所部署版本为准。

本项目主要为 Hermes 本地适配器运行的团队设计。页面读取已有运行、评论和配置，不承担 Paperclip 调度器或 Agent runner 的职责。

## 会话记录关联

当前 Hermes quiet 模式的 Paperclip stdout 可能只有最终输出，因此工具过程从本地 Hermes SQLite 获取：

1. 按成员从 Paperclip 读取最近4次运行，校验公司和成员。
2. 在 Hermes `messages` 中寻找唤醒 `user` 消息，严格匹配完整的 `- Run ID:`、`- Agent ID:` 和 `- Company ID:` 三行。
3. 若平台提供 `sessionIdAfter`，再核对会话ID；关联不唯一或不一致时拒绝拼接。
4. 仅读取该会话中唤醒之后、下一次 Paperclip 唤醒之前的 `assistant` / `tool` 消息。不会把续跑共享会话里的其他运行混入当前运行。
5. 读取公开的 content、tool_calls、tool_call_id 等字段；不选系统提示、reasoning 等列。工具按调用ID与结果配对。

每页最多60条原始助手/工具消息，先展示最新一页，按ID游标加载更早记录。同一助手消息可包含文字和多个工具调用，因此UI块数不等于原始消息行数。

字段过长时最多展示16000字符并标记截断。对已知自动化token与常见凭据字段做遮蔽，但不应把日志展示视为适合公开发布的脱敏数据集。

若会话库缺失、格式变化、没有精确标记或会话被压缩/清理，则返回明确状态。平台 `resultJson.result` / `summary` 可作为最终回复兜底，不会伪造工具结果。

## 查询边界

- 团队列表来自 `GET /api/companies`，缓存30秒；只展示 active 公司，默认团队排首位。
- 任务聚合查询带 `limit=100`，具体返回行为由上游版本决定。
- 任务进展取最近100个任务：名下未结全部保留、已完成只列最近4项；参与讨论只扫描最近12个其他任务，不是全历史。
- 检查项只读取任务描述中的 Markdown 勾选行，忽略代码块；描述被平台截断时标注“描述已截断”，不推测剩余项。
- 任务运行统计来自最近200次 heartbeat runs，按 `contextSnapshot` 的 `issueId` / `taskId` 精确归属；窗口内没有记录时显示“近期无运行记录”，不推断为从未运行。
- 评论时间线扫描最近6个名下任务与12个其他任务，输出最近160个事件，不是全历史。
- 接收对象只依据评论首行明确指向；未指定对象的消息显示实际任务讨论区。
- 回执查询最近至多200条heartbeat runs，缓存4秒，以评论ID与任务ID双重精确匹配唤醒上下文。未查到不等于无人接收，运行成功不等于逐条已读或业务验收。
- 会话最近4次运行，每次默认最近60条原始助手/工具消息；运行中读取取决于Hermes写入数据库的时机，非逐token流式输出。
- 部分任务评论有20秒缓存，可能比8秒UI轮询稍晚出现。

## 前端状态

- 成员草稿保存在当前页面的Map中，不写localStorage，刷新丢失；切换团队时清空。
- 团队选择写入 `localStorage`（`room.team`），只影响浏览器视图，不修改 Paperclip。
- 切成员时取消旧请求并校验请求序列，避免延迟响应覆盖当前成员。
- 右侧栏在任务进展与消息详情之间切换；展开的任务卡按任务ID保留，任务进展每8秒刷新且只在任务标签可见时轮询。
- 评论用稳定ID保持侧栏选择，工具按运行ID/消息ID保持展开状态；更新时尽量保留滚动锚点。
- 展开的通信详情占用真实flex布局空间；760px及以下切换至全宽详情，关闭返回会话。

## 维护与部署

`index.html`按请求读取，静态样式修改刷新可见；Python或环境配置修改需重启服务。生产部署建议先备份两个产品文件及服务配置，运行离线测试，再更新并进行只读页面验收。

完整过程功能依赖同机Hermes会话库的当前schema；升级Hermes或Paperclip后应验证身份关联、工具配对和分页。不要为了“看起来有内容”放宽精确关联或把同任务的任意运行当成评论回执。
