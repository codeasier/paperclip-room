# Changelog

## 未发布

### 后端 · 成员属性聚合（#14 / #15 / #16 / #17）

- 新增 `GET/POST /api/member-config`：一次拉取运行/身份/记忆；白名单写 model、timeoutSec（≥1200）、maxConcurrentRuns（0–8）、name、title、instructions。
- `POST /api/model` 改为调用共享 `apply_member_patch`，与属性面板同一 merge 内核；禁止 `replaceAdapterConfig`，不丢 `hermesCommand`/`env`。
- instructions：优先 Paperclip instructions-bundle（入口常见 `AGENTS.md`），否则 `adapterConfig.promptTemplate`；不可写 POST 返回 **409**。
- 记忆三块只读（sessionReuse / `.handoff/` / HERMES_DB chars）；失败局部 unavailable；无写路由。
