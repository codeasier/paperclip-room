# Changelog

## 未发布

### 后端 · 对话运行过程（`/api/chat-activity`）

- 新增 `GET /api/chat-activity`：按运行的 `sessionIdAfter` 读取本次窗口内的 Hermes 消息，输出思考、工具调用、输出三类步骤，最多 10 步、2 秒缓存。
- 只读运行窗口（`startedAt`→`finishedAt`，进行中到当前），不跨运行推断；终端参数只取 `command`，思考与输出按 400/240 字符截断。
- 与 `session_transcript` 分离：任务执行过程仍不展示 reasoning，保持原有边界；思考仅在对话运行期间展示，且先经凭据隐藏规则。

### 前端 · 对话回合状态不再空白

- 修复：等待回复的判定引用了 Paperclip 不存在的 `conversationState: "awaiting_agent"`，服务端状态永远对不上，刷新后更是一句话都没有。
- 改为按数据推导：最后一条是用户消息即视为待回复；用该会话的运行（`agent.live.runs` 中 `issueId` 命中的运行）区分“正在处理 / 排队中 / 已送达等待”。
- 消息流末尾常驻状态行，每秒刷新已处理时长与“最后一次输出距今”，超过 90 秒无运行接管时如实提示可能排在其它运行之后。
- 其余轮询与发送逻辑不变；新增 `lib/chatReply` 单测与 e2e 覆盖。
- 运行期间显示「过程」卡片：思考 / 工具 / 输出，折叠取每类最近一步，展开看最近 10 步；运行结束即卸载。

### 后端 · 成员属性聚合（#14 / #15 / #16 / #17）

- 新增 `GET/POST /api/member-config`：一次拉取运行/身份/记忆；白名单写 model、timeoutSec（≥1200）、maxConcurrentRuns（0–8）、name、title、instructions。
- `POST /api/model` 改为调用共享 `apply_member_patch`，与属性面板同一 merge 内核；禁止 `replaceAdapterConfig`，不丢 `hermesCommand`/`env`。
- instructions：优先 Paperclip instructions-bundle（入口常见 `AGENTS.md`），否则 `adapterConfig.promptTemplate`；不可写 POST 返回 **409**。
- 记忆三块只读（sessionReuse / `.handoff/` / HERMES_DB chars）；失败局部 unavailable；无写路由。
