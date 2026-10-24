# 架构与接口

[返回使用文档](../README.md)

## 数据流

```text
Browser (React + TypeScript + Ant Design)
    │ same-origin HTTP /api/*
    ▼
Python ThreadingHTTPServer (backend/paperclip_room/http.py)
    ├── Bearer token file → Paperclip REST API
    └── read-only SQLite → Hermes state.db
```

无第三方 Python 运行依赖或应用数据库。前端由 Vite 构建，产物在 `frontend/dist/`，由 Python 同源提供；开发服务器用 `/api` 代理连接 Python。密钥由后端从文件读取，不提供给浏览器。短时 TTL 缓存减少重复 API 请求；控制台不修改 Hermes 数据库。

### 代码分层

- `backend/paperclip_room/config.py`：环境变量、根目录、静态产物路径。
- `client.py`：带服务端凭据的 Paperclip HTTP 传输。
- `services.py`：团队/任务/运行/聊天/巡检聚合，Hermes 只读访问，保留现有查询和关联语义。
- `http.py`：输入校验、路由、JSON 响应与静态文件服务；`server.py` 是兼容启动器。
- `frontend/src/api/`：API 类型契约及统一读写客户端。
- `frontend/src/features/`：按成员、对话、任务、执行过程、巡检拆分 React 组件。
- `frontend/src/hooks/`：TanStack Query 请求生命周期；缓存键包含 API 路径、团队和成员，执行详情还含运行 ID。
- `frontend/src/lib/timeline.ts`：不依赖 UI 的区间、并行层级、成员筛选、时间窗口算法。
- `frontend/src/components/`：跨业务共享的 Markdown 和状态组件。

前端任务、详情、新建表单和巡检使用按需加载；Ant Design 负责通用交互，真实执行时间线保持独立组件。视觉基准为迁移前 `c0abfcf`：CSS 变量维护橙色主题，保留 64px 顶栏、260px 成员栏、贴边工作区、820px 消息/记录区、日期分组与角色头像。任务列表使用语义化 React 记录行，不套用后台管理表格外观。依赖通过 `frontend/package-lock.json` 锁定，`make check` 运行离线测试、类型检查和生产构建。

## 本项目 HTTP 接口

这些是控制台的代理接口，不是 Paperclip 原生接口。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/`、`/index.html`、`/assets/*` | Vite 生产产物，按请求读盘；缺少构建时首页返回 503 |
| GET | `/api/teams` | 当前 token 可见的 active 团队（Paperclip 公司），含默认团队标记 |
| GET | `/api/state?company=<id>` | 指定团队成员、当前任务、活跃运行与模型快照；活跃运行区分任务运行/后台运行及运行中/排队 |
| GET | `/api/ops?company=<id>` | 只读巡检：等你处理/等你回答、阻塞时长、陈旧 in_progress、近 24h 超时与失败 |
| GET | `/api/chat?company=<id>&agent=<id>` | 当前 board 用户与该成员的 Agent Chat 会话与消息 |
| POST | `/api/chat?company=<id>` | JSON `{ "agentId": "…", "text": "…" }`；发送 Agent Chat 消息，必要时自动创建会话 |
| GET | `/api/tasks?company=<id>&agent=<id>` | 成员名下未结/最近完成、近期参与讨论及有界窗口内实际执行过的任务；含检查项、运行与讨论摘要 |
| POST | `/api/tasks?company=<id>` | JSON `{ "agentId": "…", "title": "…", "description": "…", "priority": "…" }`；显式新建任务并指派 |
| GET | `/api/room?company=<id>&agent=<id>` | 成员相关任务、评论与精确运行回执 |
| GET | `/api/execution?company=<id>&agent=<id>` | 当前成员最近4次运行及最新过程页 |
| GET | `/api/run?company=<id>&agent=<id>&run=<uuid>&before=<cursor>` | 指定运行的更早过程页；校验团队与成员归属 |
| POST | `/api/send?company=<id>` | 旧版任务评论入口，保留兼容；当前界面不再使用 |
| POST | `/api/model` | JSON `{ "agentId": "…", "model": "…" }`；修改 adapterConfig.model |

除 `/api/teams` 外，所有团队相关接口都接受 `company` 参数；省略时回落到 `PAPERCLIP_COMPANY`。服务端只接受当前 token 可见且 active 的公司 ID，缓存按公司隔离。响应使用 JSON 和 `Cache-Control: no-store`。没有 SSE/WebSocket；状态5秒轮询，对话消息4秒轮询，任务进展、任务评论和过程8秒轮询，标签页进入后台时暂停。环境配置在进程启动时读取。

## Paperclip 接口依赖

后端使用公司的 agents、issues、heartbeat-runs 列表、任务 comments、Agent Chat chats 接口、单个 heartbeat run，以及成员模型 PATCH 等接口。API 根路径由 `PAPERCLIP_BASE` 追加 `/api/...` 形成。不同 Paperclip 版本或 token 权限可能影响字段和可用性，应以所部署版本为准。

本项目主要为 Hermes 本地适配器运行的团队设计。页面读取已有运行、评论和配置，不承担 Paperclip 调度器或 Agent runner 的职责。

## Agent Chat

Agent Chat 需要实例 Experimental 设置中的 `enableAgentChat` 已开启，并且后端 token 对应 board 用户。

- `GET /api/companies/{companyId}/chats/{agentId}` 读取当前 board 用户与该成员的会话；没有时返回 `null`，不会在读取时创建。
- 首次发送时 `POST` 同一路径创建会话；Paperclip 用 `(companyId, conversationAgentId, conversationUserId)` 唯一确定一条会话。
- 会话本质是被 Paperclip 从普通任务列表隐藏的 issue；消息是 issue comments，发送时必须带 `clientRequestId`。
- 本控制台的 `POST /api/chat` 会先确保会话存在，再发送评论；不调用原来“追加评论或新建任务”的 `/api/send`。
- 显式建单走 `POST /api/tasks`：创建 issue（`status=todo`，可带 `priority`），写入后清空任务/状态缓存，并让成员领取。
- 会话回复按评论轮询读取；没有 SSE/WebSocket。
- 会话属于后端 token 的 board 用户（当前 `local-board`），不同 board 用户看到不同会话。
- Agent Chat 关闭时接口返回明确状态，界面禁用输入，不会退回任务模式。

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
- 对话消息按 `order=asc` 读取全部 comments；长会话会随消息增长，当前没有做分页窗口。
- 任务聚合查询带 `limit=100`，具体返回行为由上游版本决定。
- 任务进展取最近100个任务：名下未结全部保留、已完成默认列最近4项；参与讨论只扫描最近12个其他任务。另按精确任务ID纳入运行窗口中该成员实际执行过的任务（`relation=executed`），不因已转派、取消或超出评论扫描窗口而漏掉；不额外读取任务查询范围外的 issue，不是全历史。
- 检查项只读取任务描述中的 Markdown 勾选行，忽略代码块；描述被平台截断时标注“描述已截断”，不推测剩余项。
- 任务运行统计合并团队最近200次与当前成员最近20次 heartbeat runs，按运行ID去重，再按 `contextSnapshot` 的 `issueId` / `taskId` 精确归属；窗口内没有记录时不推断为从未运行。成员查询与 `/api/execution` 复用同一份4秒缓存，严格校验团队/成员；补查失败保留已知任务，以 `scope.memberRunsAvailable=false` 和 note 标明缺口。
- `/api/tasks` 的 `attempts` 只返回运行 ID、执行成员、状态与原始创建/开始/结束时间，不携带会话或 resultJson。前端按任务与成员分轨、同轨重叠分层；只有有效开始+结束或有效开始+仍在执行的状态才绘制区间，其余有时间的记录绘制为时间点。累计执行为有效区间之和，并行区间分别计时；不以任务创建时间推算执行耗时。
- 中央时间线进一步按当前 `selected` 成员精确过滤 `attempts.agentId`；默认使用其最近一次运行结束时间（仍在执行则为当前时间）定位一小时窗口。可选6/24小时或全部查询记录，前后翻页；跨窗口区间仅裁剪显示位置，详情仍保留原始时间与耗时。空状态限定为“当前查询范围”，加载中不提前判空。
- 顶部“当前名下任务”来自当前负责人的未结任务，任务 `in_progress` 与成员真实运行状态独立。时间线单列没有当前成员可绘制时间的关联任务，明确区分无当前成员运行、只有其他成员运行和运行缺时间；不合成时间条。“成员执行中”在列表/时间线均按当前成员的 `running/queued/cancelling` 判断，不使用任务内所有成员的汇总活跃数。
- `/api/state` 的 `live` 把每条 `running/queued` 运行按是否落在当前任务窗口内分为任务运行与后台运行，并分别给出运行中/排队数量；左栏、标题和顶栏共用这份口径，不再把后台心跳写成“活跃”或“执行中”。任务视图把未出现在当前筛选任务集合内的运行单列（含状态与查看运行入口），但不为它们合成任务条。
- 任务时间线只展示最近100个任务内的运行；Agent Chat 会话运行不属于任务，会被排除，避免在时间线上出现 UUID 标题的运行卡；这类运行只作为后台运行提示出现。
- 评论时间线扫描最近6个名下任务与12个其他任务，输出最近160个事件，不是全历史。
- 巡检取最近5000个任务与2000次运行；被隐藏/删除的任务与超出窗口的运行不计入。交互只在陈旧候选（最多12条）上逐条读取。
- 接收对象只依据评论首行明确指向；未指定对象的消息显示实际任务讨论区。
- 回执查询最近至多200条heartbeat runs，缓存4秒，以评论ID与任务ID双重精确匹配唤醒上下文。未查到不等于无人接收，运行成功不等于逐条已读或业务验收。
- 会话最近4次运行，每次默认最近60条原始助手/工具消息；运行中读取取决于Hermes写入数据库的时机，非逐token流式输出。
- 部分任务评论有20秒缓存，可能比8秒UI轮询稍晚出现。

## 巡检

`/api/ops` 只读聚合，不修改任何任务或运行状态；页面顶栏「巡检」每 30 秒刷新，`ops/slo.py` 可定时拉取同一接口。

- **数据窗口**：issues `limit=5000`、heartbeat-runs `limit=2000`，结果缓存 15 秒；成员列表复用 4 秒缓存。
- **等你处理**：`blocked` 且 `unblockDescriptor.owner` 为 `board` 或带 `userId` 的任务，按阻塞时长倒序，同时给出「静默时长」（距 `lastActivityAt`）。
- **等你回答**：`in_progress` 且没有 `running/queued` 运行、但有 `pending` 交互（`ask_user_questions` 等）的任务；交互已 `expired` 的不算等你回答，按陈旧单列（最多检查 12 条任务）。
- **陈旧 in_progress**：没有活跃运行，且（未指派 或 距最后活动超过 30 分钟）。只统计平台返回的 in_progress，不推断历史。
- **近 24h 异常**：`failed` / `timed_out` 运行按 `createdAt` 落在窗口内计数。
- **配置预检**：对未暂停成员检查 `hermesCommand` 是否存在、是否配置模型、`timeoutSec` 是否低于 1200s、成员是否处于 `error`；只读，不修改配置。
- **告警**：`board_gate`、`awaiting_answer`、`stale_status`、`timeouts`（>2）、`failures`（>0）、`preflight`（配置有问题）。
- **边界**：这是“当前 board 视角”的巡检，不是全历史审计；被平台隐藏或删除的 issue 不会出现，超过 limit 的历史运行不计入。

## 前端状态

- 成员草稿保存在当前页面的Map中，不写localStorage，刷新丢失；切换团队时清空。
- 团队选择写入 `localStorage`（`room.team`），只影响浏览器视图，不修改 Paperclip。
- 查询按团队/成员/运行隔离缓存，读取函数消费 TanStack Query 的 AbortSignal；组件切换后旧响应不能覆盖新成员。
- 中央默认「对话」，任务时间线在「任务」标签只读展示；视图栏的「新建任务」是唯一的显式建单入口。
- 对话每4秒轮询，切回对话时若超过3秒会强制刷新；新建任务成功后切换到任务标签并刷新任务进展/时间线。
- 中央任务区支持记录列表和执行时间线；任务标签或详情打开时每8秒刷新任务数据。详情以评论或任务/运行 ID 绑定选择，切换成员/团队时关闭。
- 中央运行记录只渲染摘要，工具与助手输出只在 Drawer 中渲染。点击任务选择当前成员最近一次运行，点击执行行选择指定运行；详情统一按需读 `/api/run`。`useInfiniteQuery` 加载原始消息游标页并按 ID 去重，活跃详情每8秒刷新。React 稳定 key 保留同一运行中工具的展开状态。
- 对话/任务切换保留已挂载页面；聊天阅读时不强制滚到底部。Ant Design Drawer 通过 `getContainer=false`、`mask=false` 内嵌在真实 flex 侧栏中（`width: clamp(280px, 38%, 480px)`），桌面挤压中央会话，不使用覆盖式遮罩；760px及以下隐藏中央会话、侧栏占全宽，Esc 或关闭返回中央区域。
- 写操作通过 mutation 执行，关闭自动重试；网络或响应无法确认时保留输入并提示先核对实际结果。
- Agent Chat 会话 ID、会话状态和消息不写入浏览器存储；只保存团队选择。

## 维护与部署

前端源码修改需重新运行 `make build`，开发时 `make dev` 提供热更新；Python或环境配置修改需重启服务。生产部署先 `make install check`，完整部署 `backend/`、启动入口及 `frontend/dist/`，再重启并进行只读页面验收。仅更新旧的两个产品文件已不适用；没有 Node.js 的运行节点可接收构建节点生成的 `frontend/dist/`。

完整过程功能依赖同机Hermes会话库的当前schema；升级Hermes或Paperclip后应验证身份关联、工具配对和分页。不要为了“看起来有内容”放宽精确关联或把同任务的任意运行当成评论回执。

## Agent 消息围栏 → 内容卡（前端约定）

Agent 回复中的 Markdown **围栏代码块**由前端渲染为 TEXT/语言内容卡（Copy / Download），**不依赖**后端新消息类型或 Hermes 结构化载荷。

| infostring | 顶栏标签 | 下载扩展名 |
| --- | --- | --- |
| 空 / `text` / `plaintext` / `txt` | `TEXT` | `.txt` |
| 常见语言（`ts`/`bash`/`json`/…） | 短名或原名 | 对应扩展名 |
| 其他 | 原 infostring（截断约 24） | `.txt` |

空围栏（仅空白/换行）不渲染卡。行内 \`code\` 仍为 inline。JSON/Diff 审阅 UI 本迭代不做，仅共用卡壳扩展点。

