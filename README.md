# Paperclip Room

面向 [Paperclip](https://github.com/paperclipai/paperclip) 的轻量团队控制台：直接与成员对话、切换团队、查看任务进展，以及阅读助手回复和工具执行过程。

后端使用 **Python 标准库**；前端使用 **React + TypeScript + Vite + Ant Design**，通过 TanStack Query 管理服务端状态与轮询，Markdown 使用 react-markdown + remark-gfm。

源码按 `backend/`、`frontend/`、`tests/`、`deploy/` 分层。生产运行由 Python 同源提供 API 与 `frontend/dist/` 静态产物，运行节点无需安装 Node.js；前端开发与构建需要 Node.js。

## 功能

- 顶栏「巡检」入口：聚合等你处理/等你回答、阻塞时长、没有活跃运行的 in_progress，以及近 24h 的超时与适配器失败；只读，不改任何任务状态。
- 顶栏团队选择器：列出 token 可见的 Paperclip 公司（团队），切换后重新加载成员、任务与消息；选择保存在当前浏览器。
- 成员列表、职责、当前任务、运行与错误状态；默认优先选择 PL。
- 中央「任务」区支持「列表 / 时间线」直接替换：列表中的任务消息与执行记录默认收缩成行，时间线聚焦当前成员的真实运行区间，默认展示最近活动一小时；支持时间范围、翻页、缩放、搜索与状态筛选。
- 右侧只保留统一「详情」：点击消息显示正文与回执，点击任务或运行显示任务状态、检查项、讨论、子任务进度及运行时间。
- 中央默认是 Agent Chat 直接对话：消息直接唤醒成员，不创建或追加任务；每个成员与当前 board 用户一个会话。
- 点击任务或执行记录，在右侧阅读实际助手回复、工具调用与最终结果；工具调用默认折叠，展开查看参数和返回结果。
- 中央视图顶部「新建任务」：填写标题/描述/优先级，指派给当前成员并唤醒；创建后自动切到任务时间线。
- 任务消息明确显示发送者 → 接收者；点击打开统一详情抽屉，手机窄屏使用全宽抽屉。
- 评论回执按 **评论 ID + 任务 ID** 精确关联运行，区分排队、开始、成功、失败等状态。
- 对话直接发送，不需要先建任务；需要显式派活时用中央视图顶部的「新建任务」。输入区仍可按成员选择模型。
- 页面内按成员保留草稿，防重复发送、输入法回车保护、切换请求取消、轮询时保留阅读位置；后台标签页暂停轮询。

> 控制台是 Paperclip 的薄代理，不是独立 Agent 运行器。任务、评论、调度和模型配置都由现有 Paperclip 实例管理。

## 运行要求

| 条件 | 说明 |
| --- | --- |
| Python | 3.10 或以上，标准库即可 |
| Node.js | 开发/构建需要 22.12 或以上；推荐 Node 22 LTS，使用 `npm ci` 安装锁定依赖 |
| Paperclip | 已运行且可访问的实例，默认地址 `http://127.0.0.1:3100` |
| 公司 ID | 默认展示的 Paperclip company UUID；页面可切换到其他可见团队 |
| 授权密钥文件 | 一行有效 Bearer token，需具备对应公司读取权限；发送和改模型还需写入权限 |
| Hermes 会话库（可选） | 默认 `~/.hermes/state.db`，完整过程读取仅支持本文描述的 Hermes 本地适配器 |
| Agent Chat | Paperclip 实例需开启 `enableAgentChat`（Experimental）；否则对话页显示未启用 |

开启方式：在 Paperclip 的 Experimental 设置中打开 Agent Chat，或由实例管理员调用 `PATCH /api/instance/settings/experimental` 发送 `{"enableAgentChat":true}`。

> Agent Chat 会话归属于后端 token 对应的 board 用户（当前为 `local-board`）。换 token 或换 board 用户会看到不同的会话；本控制台不是多用户聊天客户端。

普通任务/评论/回执通过 HTTP API 获取。**完整助手过程与工具记录需要控制台进程能够读取 Hermes 的会话库**，因此推荐与 Hermes 部署在同一机器、以可访问该文件的用户运行。仅配置远程 `PAPERCLIP_BASE` 不会自动获得远程机器上的会话库。

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/codeasier/paperclip-room.git
cd paperclip-room
cp .env.example .env
```

仓库为私有时，需要先配置有仓库访问权限的 GitHub 凭据。

### 2. 配置公司和密钥

编辑 `.env`，至少填写真实的 `PAPERCLIP_COMPANY` 作为默认团队。公司 ID 可从 Paperclip 页面/API（`GET /api/companies`）中取得；本仓库不附带公司的数据或密钥。

密钥默认从 `~/.paperclip/cli-automation.key` 读取。若你使用其他已授权的 token 文件，设置其路径：

```dotenv
PAPERCLIP_COMPANY=your-company-uuid
PAPERCLIP_BASE=http://127.0.0.1:3100
PAPERCLIP_KEY_FILE=/absolute/path/to/paperclip-token.key
HERMES_STATE_DB=/absolute/path/to/.hermes/state.db
HOST=127.0.0.1
PORT=3200
```

token 文件仅保存 token 本身，不含 `Bearer ` 前缀。它必须由实例管理员按当前 Paperclip 的认证方式提供；一个普通成员的 token 不一定有读取其他成员或修改模型的权限。不要把 token、数据库或 `.env` 提交到 Git。

### 3. 构建前端、加载配置并启动

```bash
npm ci --prefix frontend
npm run build --prefix frontend
set -a
. ./.env
set +a
python3 server.py
```

浏览器打开 **http://127.0.0.1:3200/**。也可以用 `make install build` 构建，再在加载环境变量后运行 `make run`。`python3 -m backend.paperclip_room` 与 `python3 server.py` 等价。

前端开发：保持 Python 后端运行，在另一个终端执行 `make dev`，打开 Vite 输出的地址（默认 `http://127.0.0.1:5173`）。`/api` 默认代理到 `http://127.0.0.1:3200`，可通过 `ROOM_API_PROXY` 覆盖；页面支持热更新。该变量只用于开发代理，不改变后端的 `PAPERCLIP_BASE`。

**程序不会自动读取 `.env`**：终端启动时用上面的命令加载，systemd 则通过 `EnvironmentFile` 加载。直接运行时若缺少公司 ID 或非空密钥文件，会提示配置错误并退出。

## 配置参考

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAPERCLIP_COMPANY` | 无，必填 | 默认团队 ID；顶栏可切换到 token 可见的其他 active 团队 |
| `PAPERCLIP_BASE` | `http://127.0.0.1:3100` | Paperclip 服务根地址，**不要加 `/api`** |
| `PAPERCLIP_KEY_FILE` | `~/.paperclip/cli-automation.key` | Bearer token 文件 |
| `HERMES_STATE_DB` | `~/.hermes/state.db` | Hermes SQLite 会话库，只读访问 |
| `HOST` | `127.0.0.1` | HTTP 监听地址；局域网使用时显式设为 `0.0.0.0` |
| `PORT` | `3200` | 控制台端口，与 Paperclip 的 3100 端口不同 |

密钥和数据库路径支持 `~`，但 `.env` 建议写绝对路径，以便终端与 systemd 使用同一份配置。配置修改后需重启进程；生产前端源码修改后运行 `make build` 并刷新。未构建时首页返回明确的 503 提示，API 仍可使用。

### 局域网访问

将 `HOST=0.0.0.0`，重启后访问 `http://<部署机器IP>:3200/`。

控制台目前**没有独立登录或用户权限隔离**，访问者可使用后端 token 的权限下发任务和修改模型。默认只监听回环地址；需要远程访问时，请使用可信内网、SSH 隧道或带认证的反向代理，不应直接暴露到公网。

## 页面使用

### 切换团队

1. 顶栏团队下拉列出当前 token 可见的 active 公司；默认团队由 `PAPERCLIP_COMPANY` 决定，并排在最前。
2. 切换后会重新加载该团队的成员、任务、消息与运行记录；已展开的消息详情会关闭，草稿不跨团队保留。
3. 选择结果保存在浏览器 `localStorage`；刷新页面仍停留在该团队。团队被删除、归档或不可见时回落到默认团队。
4. 团队暂无成员时页面显示空状态，不会当成连接失败；在 Paperclip 中添加成员后自动出现。

### 与成员对话

1. 左侧选择成员；手机端在顶部横向成员列表切换。中央默认停留在「对话」标签。
2. 消息通过 Paperclip Agent Chat 发送，直接唤醒成员，不会创建普通任务；每个成员与当前 board 用户只有一个会话。
3. 成员回复以会话消息出现，每 **4 秒**轮询；消息流末尾常驻回合状态：该会话有运行在跑时显示“正在处理”及已处理时长、最后一次输出距今时间；已送达但尚未开始时显示“等待处理”；超过 90 秒仍无运行接管时如实说明可能排在其它运行之后，刷新页面也不会丢失。首次发送会自动创建会话。
4. 运行期间额外显示「过程」卡片：最近一次思考、工具调用与输出（每 3 秒刷新，可展开最近 10 步）。数据只读本次运行的 Hermes 会话窗口，运行结束即消失；凭据形态的字符串会在展示前隐藏。会话库读不到时明确提示，不伪造进度。
5. 对话历史不进入普通任务记录；需要可审计的任务记录时，请在对话中说明并由成员建单。
6. 实例未开启 Agent Chat 时，对话区显示未启用，输入框禁用；不会再退化成“发评论/建任务”。

### 查看任务时间线

1. 点击中央「任务」标签查看原任务时间线与运行过程；该视图只读，不提供发送框；新建任务请用视图顶部按钮。
2. 顶部显示“当前名下任务”及任务状态，成员是否正在执行另见上方运行/待命状态；任务“进行中”不代表该成员此刻正在运行。列表中的运行记录与消息一样收缩成行；点击运行行在右侧展示该次执行的助手回复及工具过程，再次点击同一行收起详情。
3. 在右侧展开工具卡片，查看调用参数与返回；“已返回”仅代表工具有返回记录，不等于业务验收通过。刷新保留工具展开及阅读位置。
4. 默认读取最近 **4 次运行**；每次先展示最近 **60 条助手/工具消息**。有更早内容时，点击“加载本次运行更早的过程”。
5. 状态每 **5 秒**刷新，任务时间线与活跃运行详情每 **8 秒**刷新；不是逐 token 的流式输出。历史运行通过详情抽屉按需读取。

### 下发新任务

1. 在任意视图点击中央视图右上角的「＋ 新建任务」。
2. 标题必填，描述和优先级可选；指派对象固定为当前选中的成员。
3. 创建成功后自动切到「任务」标签，并刷新任务进展、时间线和运行记录；不会在对话里生成消息。
4. 创建任务需要后端 token 具备该团队的写入权限；失败会保留表单并提示原因。

### 查看任务与详情

1. 中央「任务」区顶部切换「列表 / 时间线」，两种视图占用同一块中央区域；支持按任务编号/标题搜索、按状态筛选。
2. 「列表」保留任务状态、通信消息和执行记录，全部以紧凑行展示。点击任务状态行，右侧打开当前成员该任务的最近运行；点击某次执行行，右侧打开指定运行的工具调用与助手消息，中央保持收缩状态。
3. 「时间线」采用类似 Trace Viewer 的共享时间轴，**只显示当前成员参与执行的运行**，按任务分轨，重叠运行分层。默认聚焦最近活动 **1 小时**（以最近一次运行定位，不把空闲至今的时间拉入），可选 6 小时、24 小时或全部记录；左右箭头切换时间窗口。支持 1–64 倍缩放、横向滚动和“适应”，点击任务名或运行条在右侧查看详情。Paperclip 的 heartbeat run 不只有任务运行：定时心跳、对话唤醒和隐藏会话也会留下运行。左栏、标题和时间线使用同一口径——任务运行标为“任务运行”，无关联任务的标为“后台运行”，运行中与排队分开计数；时间线上方单列这些不绘制成任务条的运行，并可直接打开运行过程。
4. 详情使用内嵌 Ant Design Drawer，默认关闭；桌面打开时占据右侧真实布局空间并挤压中央区域，不遮挡工作区；手机窄屏暂时隐藏中央区域并展示全宽详情。点击消息显示正文和回执，点击任务或运行显示工具调用、助手消息、任务状态、检查项、讨论及运行时间。历史运行按需读取，也可加载更早过程；读取失败显示重试入口。消息详情可进入来源任务详情，关闭或按 `Esc` 返回中央。
5. 检查项从任务描述中的 Markdown 勾选项读取，代码块里的示例不计入；参与讨论只扫描最近 12 个其他任务，名下最近完成默认列 4 项。当前任务查询范围内，运行记录证明该成员实际执行过的任务也会纳入时间线，即使任务已转派或取消。详情查询范围之外的任务明确提示已有数据边界。
6. 时间条使用真实运行开始/结束时间；仍在执行的延伸到当前，排队或缺少有效区间的仅显示时间点。累计执行耗时为窗口内已知执行区间之和（并行运行分别计时），不是任务自然耗时；未记录时间不参与计算。时间线合并团队最近 200 次与当前成员最近 20 次运行，按运行 ID 去重，且仅覆盖当前任务查询所含的记录，非完整历史。
7. 当前成员没有可绘制运行时间的关联任务会单列，显示任务状态及原因；若有其他成员的运行，显示其成员名称，点击仍可查看任务详情。“全部状态”不取消成员或时间范围筛选；“成员执行中”在列表和时间线都只匹配当前成员的活跃运行。

### 查看角色通信（任务标签）

- 消息行展示原文明确的发送者与接收者，完整正文与名称在详情中展示。
- 只从评论首行解析“给 / 发给 / 交接给 / To”等明确指向；没有指定个人时显示 `#` 任务讨论区，不能按任务当前负责人倒推历史收件人。
- 点击消息行，在抽屉展示正文、来源任务、时间与运行回执；按 `Esc` 或关闭按钮收起详情。
- 中央「任务」记录统一行宽，消息以对话气泡图标开头、任务状态以任务清单图标开头、实际执行以运行图标开头，消息行保留通信方向。
- “暂无接收记录”表示当前有界查询窗口中没有精确匹配，“回执暂不可用”表示读取失败；前者不代表无人接收。运行成功也不等于已读或业务验收完成。

### 发送消息与选择模型

- 在「对话」输入消息后点击发送，或按 `Enter`；`Shift+Enter` 换行。
- 消息走 Agent Chat，直接唤醒成员；不会自动追加评论或新建普通任务。
- 需要正式派活时，使用中央视图顶部的「＋ 新建任务」，而不是在对话里隐含建单。
- 输入区模型选择会修改该成员的 Paperclip `adapterConfig.model`。
- 草稿只保留在当前页面内存，切换成员可恢复，刷新页面会丢失。
- 若发送或模型修改提示“未确认”，先核对实际结果，再决定重试。

## Linux 常驻部署（systemd 用户服务）

以下示例假定代码目录是 `~/Projects/paperclip-room/`，且 `.env` 已配置完成。

```bash
mkdir -p ~/.config/systemd/user
cp deploy/paperclip-room.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now paperclip-room
systemctl --user status paperclip-room
journalctl --user -u paperclip-room -n 100 --no-pager
```

如使用不同目录，修改服务文件中的 `WorkingDirectory` 和 `EnvironmentFile`。`python3` 必须能在用户服务的 PATH 中找到，必要时将 `ExecStart` 改成 Python 的绝对路径。需要退出登录后继续运行时，由管理员按机器策略开启该用户的 linger。

升级：

```bash
git pull --ff-only
make install
make check
systemctl --user restart paperclip-room
```

可选：每 30 分钟跑一次巡检并把指标落成时序日志（`ops/slo.py`，写入 `logs/slo.jsonl`，告警进 journal）：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/paperclip-slo.service deploy/paperclip-slo.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now paperclip-slo.timer
journalctl --user -u paperclip-slo.service -n 20 --no-pager
```

macOS 可以直接在终端运行；仓库的 systemd 模板仅适用于 Linux。

## 测试与开发

```bash
make install          # 按 package-lock.json 安装前端依赖
make dev              # Vite 热更新；后端需单独运行 make run
make test-backend     # Python 离线服务/接口测试
make test-frontend    # Vitest：成员筛选、时间区间与分层
make check            # Python + Vitest + TypeScript 严格检查 + 生产构建 + 格式检查
npm run format --prefix frontend # 自动格式化前端源码

# 浏览器离线验收（首次需要安装浏览器）
npm exec --prefix frontend -- playwright install chromium
make test-e2e         # 先构建，再用 Playwright 运行 mock API 场景
# 使用已安装的 Chrome：BROWSER_CHANNEL=chrome make test-e2e
```

测试使用固定样本、mock API 和临时 SQLite，不会调用你的 Paperclip，也不会唤醒成员或改模型。GitHub Actions 分别运行 Python 3.10 / 3.13 后端测试，以及 Node 22 前端单测、类型检查、构建与 Chromium 回归。

浏览器回归位于 `frontend/tests/`，直接验证生产构建产物；覆盖对话/建单分离、草稿、输入法保护、任务筛选、并行运行、工具配对/分页、团队切换及四档视口。`node tests/test_task_views.cjs` 保留为新回归命令的兼容入口，需要先运行 `make build`。浏览器测试不属于 `make check`，CI 单独执行。

视觉保持以迁移前 `c0abfcf` 为基准：对照测试用同一组 mock API 分别加载旧页面与 React 页面，保存桌面/手机的对话、任务列表、消息详情、时间线、运行详情、新建任务和巡检截图，并验证详情面板的布局挤压。运行这组对照需完整 Git 历史（浅克隆先补齐历史）；截图保存在忽略提交的 `frontend/test-results/`。前端组件库按原版橙色主题定制，不使用其默认视觉替换原有设计。

```text
paperclip-room/
├── server.py                    # 兼容启动入口
├── pyproject.toml               # Python 项目元数据
├── backend/paperclip_room/
│   ├── config.py                # 环境配置与静态产物路径
│   ├── client.py                # Paperclip REST 传输
│   ├── services.py              # 聚合、TTL 缓存、Hermes 只读会话
│   └── http.py                  # JSON API 和生产静态资源服务
├── frontend/
│   ├── src/app/                 # 应用入口与团队/成员工作区
│   ├── src/api/                 # 类型契约与 HTTP 客户端
│   ├── src/components/          # 共享 Markdown、状态标签
│   ├── src/features/            # agents / chat / tasks / execution / ops
│   ├── src/hooks/               # 查询生命周期
│   ├── src/lib/                 # 时间线算法、格式化及单测
│   ├── tests/                   # Playwright 离线验收
│   ├── package-lock.json        # 可复现依赖版本
│   └── dist/                    # 生产产物（不入 Git）
├── .env.example                 # 配置模板，不含密钥
├── Makefile                     # install / dev / build / run / test / check
├── deploy/paperclip-room.service # Linux 用户服务模板
├── tests/                       # 离线自动测试
├── docs/architecture.md         # 数据来源、接口、查询边界与维护说明
├── docs/ops-hardening.md        # 一次任务异常盘点的根因与加固记录
├── ops/slo.py                   # 定时巡检：/api/ops → logs/slo.jsonl
└── deploy/paperclip-slo.*       # 巡检 timer 模板
```

团队选择器与页面标题来自所选团队，成员名称/职责使用 Paperclip 数据。推荐模型列表在 `frontend/src/lib/format.ts`，合并成员当前模型；收件人别名在 `backend/paperclip_room/services.py` 的 `ROLE_ALIASES` 中维护。新增页面能力按业务放入 `frontend/src/features/`，查询统一使用带团队/成员的 query key。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 启动提示设置公司 ID | `.env` 是否真正导出到当前进程；值是否为真实 UUID |
| 启动提示密钥文件无效 | `PAPERCLIP_KEY_FILE` 是否存在、可读且非空；文件中不要包含 `Bearer ` |
| 页面连接中断 | Paperclip 地址/端口、默认公司 ID、token 权限；使用 `journalctl` 或终端日志排查 |
| 团队下拉为空或切换失败 | `/api/companies` 是否可读、token 是否有该公司权限；团队为空时会显示空状态而非连接错误 |
| 有任务评论，但没有完整工具过程 | 控制台是否与 Hermes 同机，会话库路径/权限是否正确；其他适配器目前不读取其本地会话 |
| 显示“尚未找到精确关联的会话记录” | 新运行尚未落库、身份标记/会话 ID 不匹配或记录已清理；不会用别人的会话补齐 |
| 最终回复有，但中间过程缺失 | 可能只获得 Paperclip `resultJson` 兜底，或超出默认分页窗口；检查提示与更早过程按钮 |
| 输出看起来被截短 | 单段上限为 16000 字符，页面会标注截断；这是展示限制，不表示原始记录不存在 |
| 局域网无法访问 | `HOST` 是否设为 `0.0.0.0`，监听端口和机器网络是否可达 |
| 模型修改失败 | token 写入权限，以及对应适配器是否支持所选模型 |

更多数据来源与限制见 [架构说明](docs/architecture.md)，一次异常盘点的根因与加固记录见 [ops-hardening](docs/ops-hardening.md)。
