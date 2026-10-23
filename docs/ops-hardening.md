# 一次任务异常的系统性加固（2026-10-23）

[返回使用文档](../README.md) · [架构与接口](architecture.md)

## 背景

对 Hermes Lab 公司（910A）的历史做了一次全量盘点：截至 2026-10-23 22:00（CST），共 **143 个任务**、**270 次心跳运行**。

| 维度 | 数值 |
| --- | --- |
| 任务状态 | done 111 / todo 10 / blocked 9 / in_progress 8 / in_review 3 / cancelled 2 |
| 运行状态 | succeeded 155 / cancelled 76 / timed_out 22 / failed 13 / running 4 |
| 真正异常 | 35 次失败或超时，覆盖 16 个任务 |
| 阻塞 | 9 个任务，最长 75 小时 |

## 根因（按证据分层）

### 1. 30 分钟预算不足，且不是“卡死”

22 次超时里 **20 次恰好跑满 30:01**；20 次有会话记录的超时里 **19 次在被杀前 2 分钟内仍有活动**。时间去向（22 个超时会话共 509 分钟长间隔）：

| 类别 | 占比 |
| --- | --- |
| 模型推理 | 39.7% |
| CI 等待（`gh run watch` / `sleep` 轮询） | 20.3% |
| 其他命令 | 17.1% |
| 读文件 | 10.0% |
| git/GitHub 网络 | 8.3% |
| 测试执行 | 4.6% |

### 2. 会话不续跑，重试等于重来

22 个超时运行对应 **22 个全新 session（0 复用）**，`persistSession=true` 没有生效；每次重跑平均 5.6 次 Paperclip API 调用、1.3 次重读说明文件、19.4 万 input tokens。HER-17 连烧 6 个 30 分钟，实质是同一段探索重复 6 遍。

### 3. 并发=1 + 排队中改派 = 26% 运行被取消

Architect/Backend/DevOps/Frontend/QA 的 `maxConcurrentRuns` 都是 1；队列等待 p90 7 分钟、最长 78 分钟。76 次 cancelled 中 **70 次是 `issue_reassigned`**，Architect 47 次运行有 33 次没跑起来。典型任务 HER-42/HER-16 各跑了 11 次、HER-23 跑了 10 次。

### 4. 重试不改变失败条件

30 个 `retryOfRunId`；同形态重试两次后由平台判定“bounded retry budget spent”并自动 block（HER-1、HER-17）。重试既没有换策略，也没有续上下文。

### 5. 配置层三次“启动即死”

- Designer 使用 `muse-spark-1.3-contributor`（贡献者档），非交互下 `Exit code: 1` 连挂 3 次；
- Hermes Worker 早期 `Failed to start command "hermes"`（PATH 未用绝对路径），5 次失败后 paused；
- PL 声明的 `paperclipai/paperclip/*` 技能与 `~/.hermes/skills/paperclip` 旧软链冲突，曾报 “occupied by another installation”。

### 6. 人类闸门没有显式化

5 个任务在等用户授权/拍板（PR #222/#226/#233/#243），最长 50 小时；等待状态被写成 `in_progress` 空挂，watchdog 还会把“合法等待”判成 `deliberate_wait_without_target`。

## 已落地的改动

### 运行时配置（Paperclip API）

| 角色 | timeoutSec | maxConcurrentRuns |
| --- | --- | --- |
| Backend / DevOps / Frontend | 1800 → **3600** | 1 → **2** |
| Architect / PL | 1800 → **2700** | 1 → **2** / 3 |
| QA / Analyst / Designer | 1800 | 1 → **2** |

### 团队协议（8 个成员的 TEAM.md，统一推送）

- **禁止在 run 内等 CI**：给出 `executionPolicy.monitor` 的定时回看写法（到点唤醒），替代 `gh run watch` / `sleep` 轮询；
- **改派互斥**：改派前查 `activeRun`，排队/运行中不许改派；一轮只推进一步；
- **任务切片**：单条 issue 预计净工作 ≤ 20 分钟，超了先拆子任务；
- **状态要真实**：`in_progress` 必须有活 run，等外部条件用 monitor 或 blocked + `unblockDescriptor`；
- **交接文件**：每轮读写 `.handoff/HER-<n>.md`，缓解会话不续跑；
- **运行节奏**：预算用掉 60% 就写交接、交棒。

配套在每个克隆根目录建了 `.handoff/` 并写入 `.git/info/exclude`。

### 任务清理

- HER-1（阻塞 75 小时，环境问题已修复）：结单；
- HER-17（6 次超时后被自动 block）：重新打开并限定范围，**1 分 21 秒收口**（残余两条早已随 PR #214 合入，本次只做核验）；
- HER-110 / HER-124 / HER-28：由 `in_progress` 空挂改为 `blocked` 并写清解除条件；
- HER-137：改为等用户二选一（网页端直补 / 授权角色走 PR）。

### 可观测性

- `GET /api/ops`：聚合“等你处理 / 等你回答 / 陈旧 in_progress / 近 24h 异常 / 配置预检”，只读；
- 顶栏「巡检」入口 + 弹窗明细，30 秒刷新；
- `ops/slo.py` + systemd timer：每 30 分钟落一条 `logs/slo.jsonl`，告警写 journal。

## 验证

- `make test`：81 个单元测试通过（新增 ops 与 slo 共 9 个）；
- 部署后 `/api/ops` 实测返回：阻塞 9（等你 3）、待回答 1、近 24h 超时 5 / 失败 1；
- HER-17 由 50 小时 blocked 变为 1 分 21 秒收口；
- 超时预算与并发度已通过 `GET /api/companies/<id>/agents` 复核生效。

## 仍未做（需要更大改动或人工决策）

1. **会话续跑（部分缺口）**：adapter 本身支持 `persistSession` + `--resume`，成功运行会把 session 写进 runtime-state；但**超时/被杀路径下会话没有落库**，所以“超时→重试”仍会开新会话。修复点在 adapter（vendor 代码），本仓库不直接改，先用交接文件缓解。
2. **事件驱动解锁**：PR 合入后自动解除依赖任务的阻塞（HER-82/HER-137 这类），需要把 GitHub webhook 接到 Paperclip 的 issue 更新上。
3. **重试策略**：超时自动改为“拆解后重试”，需要改平台恢复逻辑或增加一个调度 sidecar。
4. **人类闸门批处理**：每日合并授权窗口仍是流程约定，尚未做成固定 routine。
