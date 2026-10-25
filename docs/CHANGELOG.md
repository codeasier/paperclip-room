# Changelog

## 未发布

### 对话 · 按事件自然流动

- 去掉集中折叠的「思考 N 次 · 执行 M 条命令」过程卡片：思考、助手 Markdown 正文和工具调用按事件顺序穿插；每段思考、每次工具各自展开，不互相影响。
- 工具参数与结果按 `toolCallId` 精确配对，支持并行工具反序返回；默认收起大段输出与错误堆栈，展开保留多行，不再将正文压成单行「回复」。
- 与平台发布的相同助手回复按运行时间窗去重；进行中有中间正文仍显示运行状态。新事件在底部跟随，向上阅读时不抢滚动位置。
- `/api/chat` 补充当前成员最近 20 次运行窗口内、本会话最近 6 次运行的标识；结束后过程不再消失，刷新也可恢复这段有界历史。任务执行过程仍不展示 reasoning。

### 后端 · 对话运行过程（`/api/chat-activity`）

- 按运行会话与开始/结束窗口读取 Hermes 思考、助手正文、工具调用及结果；支持运行中 `sessionIdBefore` 和唯一新会话回退，2 秒缓存。
- 每次最多 400 个事件，单条最多 16,000 字符；保留多行，省略历史或截断内容均明确标记。思考、助手正文、调用和结果都先经凭据隐藏规则。
- 运行完成状态参与缓存标识，避免结束后仍显示旧过程；任务 `session_transcript` 的无 reasoning 边界保持不变。

### 前端 · 对话回合状态不再空白

- 修复：等待回复的判定引用了 Paperclip 不存在的 `conversationState: "awaiting_agent"`，服务端状态永远对不上，刷新后更是一句话都没有。
- 改为按数据推导：最后一条是用户消息即视为待回复；用该会话的运行（`agent.live.runs` 中 `issueId` 命中的运行）区分“正在处理 / 排队中 / 已送达等待”。
- 消息流末尾常驻状态行，每秒刷新已处理时长与“最后一次输出距今”，超过 90 秒无运行接管时如实提示可能排在其它运行之后。
- 其余轮询与发送逻辑不变；新增 `lib/chatReply` 单测与 e2e 覆盖。
- 运行期间显示灰色「过程」块：折叠为一行摘要（思考 N 次 · 执行 M 条命令 + 最新命令），展开为逐条 思考过程 / 已执行 / 输出，最多 10 步；模型首个输出前显示等待原因；运行结束即卸载。

### 后端 · 成员属性聚合（#14 / #15 / #16 / #17）

- 新增 `GET/POST /api/member-config`：一次拉取运行/身份/记忆；白名单写 model、timeoutSec（≥1200）、maxConcurrentRuns（0–8）、name、title、instructions。
- `POST /api/model` 改为调用共享 `apply_member_patch`，与属性面板同一 merge 内核；禁止 `replaceAdapterConfig`，不丢 `hermesCommand`/`env`。
- instructions：优先 Paperclip instructions-bundle（入口常见 `AGENTS.md`），否则 `adapterConfig.promptTemplate`；不可写 POST 返回 **409**。
- 记忆三块只读（sessionReuse / `.handoff/` / HERMES_DB chars）；失败局部 unavailable；无写路由。
