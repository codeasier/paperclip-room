# Paperclip Room

面向 [Paperclip](https://github.com/paperclipai/paperclip) 的轻量团队控制台：直接与成员对话、切换团队、查看任务进展，以及阅读助手回复和工具执行过程。

后端使用 **Python 标准库**，前端是一个原生 HTML/CSS/JavaScript 页面；无需 `pip install`、Node.js 或前端构建。

## 功能

- 顶栏团队选择器：列出 token 可见的 Paperclip 公司（团队），切换后重新加载成员、任务与消息；选择保存在当前浏览器。
- 成员列表、职责、当前任务、运行与错误状态；默认优先选择 PL。
- 右侧任务进展：按成员列出名下未结、参与讨论与最近完成的任务，显示状态阶段、检查项、运行成败、最近讨论和子任务进度。
- 任务进展支持「列表 / 时间线」切换：按任务与执行成员分轨呈现真实运行区间，重叠运行分层显示；支持缩放、搜索与状态筛选。
- 中央默认是 Agent Chat 直接对话：消息直接唤醒成员，不创建或追加任务；每个成员与当前 board 用户一个会话。
- 「任务」标签保留原任务时间线：实际助手回复、运行起止时间、最终结果；工具调用默认折叠，展开查看参数和返回结果。
- 中央视图顶部「新建任务」：填写标题/描述/优先级，指派给当前成员并唤醒；创建后自动切到任务时间线。
- 用角色头像表示发送者 → 接收者；点击在右侧同一栏查看消息详情，关闭侧栏恢复会话宽度。手机窄屏切换至侧栏视图。
- 评论回执按 **评论 ID + 任务 ID** 精确关联运行，区分排队、开始、成功、失败等状态。
- 对话直接发送，不需要先建任务；需要显式派活时用中央视图顶部的「新建任务」。输入区仍可按成员选择模型。
- 页面内按成员保留草稿，防重复发送、输入法回车保护、切换请求取消、轮询时保留阅读位置；后台标签页暂停轮询。

> 控制台是 Paperclip 的薄代理，不是独立 Agent 运行器。任务、评论、调度和模型配置都由现有 Paperclip 实例管理。

## 运行要求

| 条件 | 说明 |
| --- | --- |
| Python | 3.10 或以上，标准库即可 |
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

### 3. 加载配置并启动

```bash
set -a
. ./.env
set +a
python3 server.py
```

浏览器打开 **http://127.0.0.1:3200/**。也可以在加载环境变量后运行 `make run`。

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

密钥和数据库路径支持 `~`，但 `.env` 建议写绝对路径，以便终端与 systemd 使用同一份配置。配置修改后需重启进程；单独修改 `index.html` 后刷新即可。

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
3. 成员回复以会话消息出现，每 **4 秒**轮询；等待回复时显示“正在回复”。首次发送会自动创建会话。
4. 对话历史不进入任务列表，也不会显示在右侧「任务进展」里；需要可审计的任务记录时，请在对话中说明并由成员建单。
5. 实例未开启 Agent Chat 时，对话区显示未启用，输入框禁用；不会再退化成“发评论/建任务”。

### 查看任务时间线

1. 点击中央「任务」标签查看原任务时间线与运行过程；该视图只读，不提供发送框；新建任务请用视图顶部按钮。
2. 顶部显示当前任务和状态。按运行展示助手回复及工具过程。
3. 展开工具卡片，查看调用参数与返回；“已返回”仅代表工具有返回记录，不等于业务验收通过。
4. 默认读取最近 **4 次运行**；每次先展示最近 **60 条助手/工具消息**。有更早内容时，点击“加载本次运行更早的过程”。
5. 状态每 **5 秒**刷新，任务时间线与执行会话每 **8 秒**刷新；不是逐 token 的流式输出。

### 下发新任务

1. 在任意视图点击中央视图右上角的「＋ 新建任务」。
2. 标题必填，描述和优先级可选；指派对象固定为当前选中的成员。
3. 创建成功后自动切到「任务」标签，并刷新任务进展、时间线和运行记录；不会在对话里生成消息。
4. 创建任务需要后端 token 具备该团队的写入权限；失败会保留表单并提示原因。

### 查看任务进展

1. 桌面端右侧默认打开“任务进展”；窄屏点击顶栏“任务”按钮打开，关闭后回到会话。
2. 「列表」按“名下未结”“参与讨论”“最近完成”分组，顶部汇总当前筛选范围的任务数、执行中与受阻数；支持按编号/标题搜索、按状态筛选。卡片突出状态、优先级、最近动态与累计执行耗时，点击展开检查项、最近 3 条讨论、运行状态与失败原因。
3. 四段进度条对应待办 / 进行中 / 待评审 / 完成，只由任务状态推导，不计算虚假百分比；受阻任务用红色条纹提示。
4. 检查项从任务描述中的 Markdown 勾选项读取，代码块里的示例不计入；参与讨论只扫描最近 12 个其他任务，最近完成只列 4 项。
5. 在「任务」标签点击头像消息会切到同一右侧栏的“消息详情”，再点“任务进展”或关闭侧栏即可返回。
6. 「时间线」采用类似 Trace Viewer 的共享时间轴，按“任务 × 执行成员”分轨；同一成员的重叠运行也会分层。支持 1–8 倍缩放、横向滚动和“适应”，点击运行条查看任务详情与精确起止时间。
7. 时间条使用真实运行开始/结束时间；仍在执行的延伸到当前，排队或缺少有效区间的仅显示时间点。累计执行耗时为窗口内已知执行区间之和（并行运行分别计时），不是任务自然耗时；未记录时间不参与计算。时间线只覆盖最近 200 次运行查询窗口内、当前任务面板所含的记录。

### 查看角色通信（任务标签）

- 头像条表示原文明确的发送者与接收者，悬停可看名称，完整名称在详情中展示。
- 只从评论首行解析“给 / 发给 / 交接给 / To”等明确指向；没有指定个人时显示 `#` 任务讨论区，不能按任务当前负责人倒推历史收件人。
- 点击头像消息，右侧展示正文、来源任务、时间与运行回执；再次点击或 `Esc` 收起消息详情，侧栏关闭按钮则收起整个侧栏。
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
make check
systemctl --user restart paperclip-room
```

macOS 可以直接在终端运行；仓库的 systemd 模板仅适用于 Linux。

## 测试与开发

```bash
make check
# 或
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

测试使用固定样本、mock API 和临时 SQLite，不会调用你的 Paperclip，也不会唤醒成员或改模型。GitHub Actions 在 Python 3.10 / 3.13 上运行相同检查。

可选的前端离线回归：在可解析 `playwright` 包且安装了对应浏览器的环境执行 `node tests/test_task_views.cjs`；也可用 `BROWSER_CHANNEL=chrome` 使用已安装的 Chrome。覆盖并行分轨、未知时间、视图切换、筛选、展开/滚动保留与四档视口；它不属于标准库 `make check`。

```text
paperclip-room/
├── server.py                    # 标准库 HTTP 服务、Paperclip 聚合与 Hermes 只读会话
├── index.html                   # 原生前端，无构建步骤
├── .env.example                 # 配置模板，不含密钥
├── Makefile                     # run / test / check
├── deploy/paperclip-room.service # Linux 用户服务模板
├── tests/                       # 离线自动测试
└── docs/architecture.md         # 数据来源、接口、查询边界与维护说明
```

品牌名称、顶栏头像首字母和页面标题来自所选团队，不再硬编码。`ROLES` 只用于 Hermes 预设角色的中文短标签与排序；不在预设中的成员按 Paperclip `title` 显示，头像使用名称首字母。`MODELS` 是推荐模型列表，仍会合并成员当前模型；收件人别名在 `server.py` 的 `ROLE_ALIASES` 中维护。

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

更多数据来源与限制见 [架构说明](docs/architecture.md)。
