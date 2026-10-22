# Paperclip Room

面向 [Paperclip](https://github.com/paperclipai/paperclip) 的轻量团队控制台：查看成员进展、下发任务、选择模型，以及阅读助手回复和工具执行过程。

后端使用 **Python 标准库**，前端是一个原生 HTML/CSS/JavaScript 页面；无需 `pip install`、Node.js 或前端构建。

## 功能

- 成员列表、职责、当前任务、运行与错误状态；默认优先选择 PL。
- 右侧任务进展：按成员列出名下未结、参与讨论与最近完成的任务，显示状态阶段、检查项、运行成败、最近讨论和子任务进度。
- 中央展示实际助手回复、运行起止时间、最终结果；工具调用默认折叠，展开查看参数和返回结果。
- 用角色头像表示发送者 → 接收者；点击在右侧同一栏查看消息详情，关闭侧栏恢复会话宽度。手机窄屏切换至侧栏视图。
- 评论回执按 **评论 ID + 任务 ID** 精确关联运行，区分排队、开始、成功、失败等状态。
- 向当前成员发消息：有进行中/待办任务时追加评论，否则新建任务；按成员选择模型。
- 页面内按成员保留草稿，防重复发送、输入法回车保护、切换请求取消、轮询时保留阅读位置；后台标签页暂停轮询。

> 控制台是 Paperclip 的薄代理，不是独立 Agent 运行器。任务、评论、调度和模型配置都由现有 Paperclip 实例管理。

## 运行要求

| 条件 | 说明 |
| --- | --- |
| Python | 3.10 或以上，标准库即可 |
| Paperclip | 已运行且可访问的实例，默认地址 `http://127.0.0.1:3100` |
| 公司 ID | 要展示的 Paperclip company UUID |
| 授权密钥文件 | 一行有效 Bearer token，需具备对应公司读取权限；发送和改模型还需写入权限 |
| Hermes 会话库（可选） | 默认 `~/.hermes/state.db`，完整过程读取仅支持本文描述的 Hermes 本地适配器 |

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

编辑 `.env`，至少填写真实的 `PAPERCLIP_COMPANY`。公司 ID 可从 Paperclip 页面/API 中已有的公司信息取得；本仓库不附带公司的数据或密钥。

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
| `PAPERCLIP_COMPANY` | 无，必填 | 目标公司 ID |
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

### 查看进展与过程

1. 左侧选择成员；手机端在顶部横向成员列表切换。
2. 顶部显示当前任务和状态。中央按运行展示助手回复及工具过程。
3. 展开工具卡片，查看调用参数与返回；“已返回”仅代表工具有返回记录，不等于业务验收通过。
4. 默认读取最近 **4 次运行**；每次先展示最近 **60 条助手/工具消息**。有更早内容时，点击“加载本次运行更早的过程”。
5. 状态每 **5 秒**刷新，任务进展、消息和执行会话每 **8 秒**刷新；不是逐 token 的流式输出。

### 查看任务进展

1. 桌面端右侧默认打开“任务进展”；窄屏点击顶栏“任务”按钮打开，关闭后回到会话。
2. 任务按“名下未结”“参与讨论”“最近完成”分组。点击卡片展开检查项、最近 3 条讨论、运行状态与失败原因。
3. 四段进度条对应待办 / 进行中 / 待评审 / 完成，只由任务状态推导，不计算虚假百分比；受阻任务用红色条纹提示。
4. 检查项从任务描述中的 Markdown 勾选项读取，代码块里的示例不计入；参与讨论只扫描最近 12 个其他任务，最近完成只列 4 项。
5. 点击头像消息会切到同一右侧栏的“消息详情”标签，再点“任务进展”或关闭侧栏即可返回。

### 查看角色通信

- 头像条表示原文明确的发送者与接收者，悬停可看名称，完整名称在详情中展示。
- 只从评论首行解析“给 / 发给 / 交接给 / To”等明确指向；没有指定个人时显示 `#` 任务讨论区，不能按任务当前负责人倒推历史收件人。
- 点击头像消息，右侧展示正文、来源任务、时间与运行回执；再次点击或 `Esc` 收起消息详情，侧栏关闭按钮则收起整个侧栏。
- “暂无接收记录”表示当前有界查询窗口中没有精确匹配，“回执暂不可用”表示读取失败；前者不代表无人接收。运行成功也不等于已读或业务验收完成。

### 发送消息与选择模型

- 输入需求后点击发送，或按 `Enter`；`Shift+Enter` 换行。
- 后端优先寻找成员名下的 `in_progress` / `todo` 任务并追加评论；没有时新建任务。这是任务协作入口，不是独立的点对点聊天服务。
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

角色顺序、职责、头像缩写和推荐模型在 `index.html` 的 `ROLES` / `MODELS` 中配置；收件人别名在 `server.py` 的 `ROLE_ALIASES` 中维护。现有页面以 PL、Analyst、Designer、Architect、Frontend、Backend、QA、DevOps 团队为预设；其他成员仍可显示，但自定义团队需按需调整这些映射和品牌文字。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 启动提示设置公司 ID | `.env` 是否真正导出到当前进程；值是否为真实 UUID |
| 启动提示密钥文件无效 | `PAPERCLIP_KEY_FILE` 是否存在、可读且非空；文件中不要包含 `Bearer ` |
| 页面连接中断或没有成员 | Paperclip 地址/端口、公司 ID、token 权限；使用 `journalctl` 或终端日志排查 |
| 有任务评论，但没有完整工具过程 | 控制台是否与 Hermes 同机，会话库路径/权限是否正确；其他适配器目前不读取其本地会话 |
| 显示“尚未找到精确关联的会话记录” | 新运行尚未落库、身份标记/会话 ID 不匹配或记录已清理；不会用别人的会话补齐 |
| 最终回复有，但中间过程缺失 | 可能只获得 Paperclip `resultJson` 兜底，或超出默认分页窗口；检查提示与更早过程按钮 |
| 输出看起来被截短 | 单段上限为 16000 字符，页面会标注截断；这是展示限制，不表示原始记录不存在 |
| 局域网无法访问 | `HOST` 是否设为 `0.0.0.0`，监听端口和机器网络是否可达 |
| 模型修改失败 | token 写入权限，以及对应适配器是否支持所选模型 |

更多数据来源与限制见 [架构说明](docs/architecture.md)。
