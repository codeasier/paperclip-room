#!/usr/bin/env python3
"""Paperclip 极简控制台 —— 一个薄代理 + 一个静态页面。

设计目标：只做三件事——看进展、下发任务、配模型。
不复制 Paperclip 的业务逻辑；通过短时 TTL 缓存降低轮询开销。

启动：
    python3 server.py            # 默认 127.0.0.1:3200，配置见 README.md
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.parse import quote
from datetime import datetime, timezone
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent

PAPERCLIP = os.environ.get("PAPERCLIP_BASE", "http://127.0.0.1:3100").rstrip("/")
COMPANY = os.environ.get("PAPERCLIP_COMPANY", "").strip()
KEY_FILE = Path(os.environ.get("PAPERCLIP_KEY_FILE", Path.home() / ".paperclip" / "cli-automation.key")).expanduser()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3200"))
HERMES_DB = Path(os.environ.get("HERMES_STATE_DB", Path.home() / ".hermes" / "state.db")).expanduser()

# 这些状态算"在办"，发消息时优先挂到这种任务上
OPEN_STATES = ("in_progress", "in_review", "todo", "blocked")

# 任务进展面板：排序、最近完成数量、参与任务扫描窗口
TASK_ORDER = {"in_progress": 0, "blocked": 1, "in_review": 2, "todo": 3, "backlog": 4}
TASK_RECENT_DONE = 4
TASK_PARTICIPATION_WINDOW = 12
MEMBER_RUN_LIMIT = 20
TASK_PRIORITIES = ("low", "medium", "high", "critical")
CHECKBOX_RE = re.compile(r"^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$", re.M)


def api_key():
    return KEY_FILE.read_text().strip()


def call(method, path, body=None):
    """调 Paperclip API，返回 (status, parsed_json)。"""
    url = PAPERCLIP + path
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + api_key())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode("utf-8", "replace")[:300]}
    except Exception as e:  # 网络/超时
        return 599, {"error": str(e)}


def _ts(iso):
    """ISO 时间 → epoch 秒。解析失败返回 0，别让一条脏数据把整页拖垮。"""
    if not iso:
        return 0
    try:
        from datetime import datetime, timezone
        s = iso.replace("Z", "+00:00")
        return datetime.fromisoformat(s).astimezone(timezone.utc).timestamp()
    except Exception:
        return 0


def as_list(payload, *keys):
    """Paperclip 有的接口返回 list，有的返回 {items:[...]}，统一一下。"""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in keys:
            v = payload.get(k)
            if isinstance(v, list):
                return v
    return []


# ---------------------------------------------------------------- 数据聚合

_CACHE = {}


def cached(key, ttl, fn):
    """简单 TTL 缓存。房间视图要扫十几个 issue，没有缓存每 8 秒会打爆 API。"""
    hit = _CACHE.get(key)
    now = time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _CACHE[key] = (now, val)
    return val


def fetch_companies():
    st, data = call("GET", "/api/companies")
    return as_list(data, "companies") if st == 200 else []


def company_list():
    """当前 token 可见的公司（团队）。名称和状态变化不频繁，缓存30秒。"""
    return cached("companies", 30.0, fetch_companies)


def resolve_company(value):
    """把请求里的团队参数收敛到可见公司；空值回落到服务端默认团队。"""
    value = (value or "").strip()
    if not value or value == COMPANY:
        return COMPANY
    return value if any(item.get("id") == value and item.get("status") in (None, "active")
                        for item in company_list()) else None


def teams_payload():
    """顶栏团队选择器数据；默认团队排在最前，列表不可用时回落到环境默认。"""
    teams = []
    seen = set()
    for item in company_list():
        company_id = item.get("id")
        if not company_id or company_id in seen:
            continue
        if item.get("status") and item["status"] != "active":
            continue
        seen.add(company_id)
        teams.append({
            "id": company_id,
            "name": item.get("name") or "未命名团队",
            "issuePrefix": item.get("issuePrefix"),
            "description": item.get("description"),
            "logoUrl": item.get("logoUrl"),
        })
    if not teams:
        teams.append({"id": COMPANY, "name": "当前团队", "issuePrefix": None,
                      "description": None, "logoUrl": None})
    default = COMPANY if COMPANY in {item["id"] for item in teams} else teams[0]["id"]
    for item in teams:
        item["isDefault"] = item["id"] == default
    teams.sort(key=lambda item: (0 if item["isDefault"] else 1,
                                 (item.get("name") or "").casefold()))
    return {"teams": teams, "default": default}


def fetch_agents(company=None):
    company = company or COMPANY
    st, data = call("GET", f"/api/companies/{company}/agents")
    if st != 200:
        return []
    return as_list(data, "agents")


def agents_for(company):
    return cached("agents:" + company, 4.0, lambda: fetch_agents(company))


def fetch_issues(company=None):
    company = company or COMPANY

    def _load():
        st, data = call("GET", f"/api/companies/{company}/issues?limit=100")
        return as_list(data, "issues") if st == 200 else []
    return cached("issues:" + company, 4.0, _load)


def fetch_runs(company=None):
    company = company or COMPANY
    st, data = call("GET", f"/api/companies/{company}/heartbeat-runs?limit=200")
    if st != 200:
        return []
    return as_list(data, "runs")


def fetch_agent_runs(agent_id, company=None):
    """成员自己的有界运行窗口，供记录列表和任务时间线共同使用。"""
    company = company or COMPANY

    def _load():
        status, data = call("GET", f"/api/companies/{company}/heartbeat-runs?agentId={quote(agent_id, safe='')}&limit={MEMBER_RUN_LIMIT}")
        if status != 200 or not (isinstance(data, list) or isinstance(data, dict) and isinstance(data.get("runs"), list)):
            return {"available": False, "runs": []}
        return {"available": True, "runs": [
            run for run in as_list(data, "runs")[:MEMBER_RUN_LIMIT]
            if run.get("agentId") == agent_id and run.get("companyId") == company
        ]}
    return cached("member-runs:" + company + ":" + agent_id, 4.0, _load)


def fetch_comments(issue_id):
    def _load():
        st, data = call("GET", f"/api/issues/{issue_id}/comments")
        return as_list(data, "comments") if st == 200 else []
    return cached("c:" + issue_id, 20.0, _load)


def live_run_view(run, issues_by_id):
    """把一条 heartbeat run 压成 UI 能解释的状态。

    `heartbeat-runs` 同时包含任务运行、隐藏的对话会话运行和定时心跳；
    后两者没有当前任务窗口内的 issue，不能当成"有任务在执行"。
    """
    context = run.get("contextSnapshot")
    context = context if isinstance(context, dict) else {}
    issue_id = run.get("issueId") or context.get("issueId") or context.get("taskId")
    issue = issues_by_id.get(issue_id) if issue_id else None
    return {
        "id": run.get("id"),
        "status": run.get("status"),
        "startedAt": run.get("startedAt"),
        "createdAt": run.get("createdAt"),
        # 最后一次输出时间：运行很久仍有输出，和完全没动静不是一回事
        "lastOutputAt": run.get("lastOutputAt"),
        "issueId": issue_id,
        "issue": issue.get("identifier") if issue else None,
        "issueTitle": issue.get("title") if issue else None,
        # 任务不在当前100条窗口时仍保留唤醒时的编号，方便辨认是对话还是较早任务
        "taskKey": context.get("taskKey"),
        "linked": bool(issue),
        # 有 issue 但不在当前任务窗口：通常是隐藏的对话会话或较早的任务
        "unlisted": bool(issue_id and not issue),
        "source": run.get("invocationSource"),
        "scope": run.get("scopeKind"),
    }


def agent_snapshot(company=None):
    """左栏用：每个 agent 一行，带状态和当前任务。"""
    company = company or COMPANY
    agents = agents_for(company)
    issues = fetch_issues(company)
    runs = fetch_runs(company)

    # 每个 agent 的活跃任务：优先 in_progress，其次 updatedAt 最新
    by_agent = {}
    for it in issues:
        aid = it.get("assigneeAgentId")
        if not aid:
            continue
        by_agent.setdefault(aid, []).append(it)
    issues_by_id = {it.get("id"): it for it in issues
                    if isinstance(it, dict) and it.get("id")}

    # 最近一次 run 的结局，用来标红/标绿
    last_run = {}
    for r in runs:
        aid = r.get("agentId")
        if aid and aid not in last_run:
            last_run[aid] = r

    live = [r for r in runs if r.get("status") in ("running", "queued")]
    live_by_agent = {}
    for r in live:
        live_by_agent.setdefault(r.get("agentId"), []).append(r)
    live_views = {aid: [live_run_view(run, issues_by_id) for run in agent_runs]
                  for aid, agent_runs in live_by_agent.items()}

    out = []
    for a in agents:
        # 暂停的（历史遗留 agent）不进列表：它们不接活，只会干扰判断
        if a.get("status") == "paused":
            continue
        aid = a.get("id")
        # 只把「没结束的任务」当作当前任务：done/cancelled 挂在"当前"上会误导
        open_ones = [x for x in by_agent.get(aid, []) if x.get("status") in OPEN_STATES]
        open_ones.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
        open_ones.sort(key=lambda x: 0 if x.get("status") == "in_progress" else 1)
        current = open_ones[0] if open_ones else None
        running = live_by_agent.get(aid, [])
        views = live_views.get(aid, [])
        # 运行中的排前面；同类按开始时间倒序，最近的先看
        views.sort(key=lambda r: r.get("startedAt") or r.get("createdAt") or "", reverse=True)
        views.sort(key=lambda r: 0 if r.get("status") == "running" else 1)
        live_running = [r for r in views if r.get("status") == "running"]
        live_queued = [r for r in views if r.get("status") == "queued"]
        task_views = [r for r in views if r.get("linked")]
        background_views = [r for r in views if not r.get("linked")]
        lr = last_run.get(aid) or {}
        out.append({
            "id": aid,
            "name": a.get("name"),
            "title": a.get("title"),
            "status": a.get("status"),           # idle / running / error / paused
            "running": len(running),
            "live": {
                "running": len(live_running),
                "queued": len(live_queued),
                "task": len(task_views),
                "background": len(background_views),
                "taskRunning": sum(1 for r in task_views if r.get("status") == "running"),
                "taskQueued": sum(1 for r in task_views if r.get("status") == "queued"),
                "backgroundRunning": sum(1 for r in background_views if r.get("status") == "running"),
                "backgroundQueued": sum(1 for r in background_views if r.get("status") == "queued"),
                "runs": views,
            },
            "model": (a.get("adapterConfig") or {}).get("model"),
            "lastRunStatus": lr.get("status"),
            "lastRunError": lr.get("error"),
            # 最后失败是多久以前：状态是残留的，必须带时间，否则看起来像刚炸
            "lastRunAt": lr.get("finishedAt") or lr.get("createdAt"),
            "lastRunAgeMin": None if not (lr.get("finishedAt") or lr.get("createdAt"))
            else int((time.time() - _ts(lr.get("finishedAt") or lr.get("createdAt"))) / 60),
            "current": None if not current else {
                "identifier": current.get("identifier"),
                "title": current.get("title"),
                "status": current.get("status"),
            },
            "openCount": sum(1 for x in by_agent.get(aid, [])
                             if x.get("status") in OPEN_STATES),
        })

    # 真正执行任务的排最前，其次后台运行，再其次排队；同组内按固定角色顺序
    role = {n: i for i, n in enumerate(
        ["PL", "Analyst", "Designer", "Architect", "Frontend", "Backend", "QA", "DevOps"])}
    out.sort(key=lambda x: (
        0 if x["live"]["taskRunning"] else
        1 if x["live"]["backgroundRunning"] else
        2 if x["live"]["queued"] else 3,
        role.get(x["name"], 99),
    ))
    # 总数与列表里的行保持同一口径：页面顶栏说有几个，左栏就能数出几个
    live_running_total = sum(item["live"]["running"] for item in out)
    live_queued_total = sum(item["live"]["queued"] for item in out)
    live_task_total = sum(item["live"]["task"] for item in out)
    live_background_total = sum(item["live"]["background"] for item in out)
    live_task_running = sum(item["live"]["taskRunning"] for item in out)
    live_background_running = sum(item["live"]["backgroundRunning"] for item in out)
    return {
        "agents": out,
        "liveRuns": live_running_total + live_queued_total,
        "liveRunning": live_running_total,
        "liveQueued": live_queued_total,
        "liveTaskRuns": live_task_total,
        "liveBackgroundRuns": live_background_total,
        "liveTaskRunning": live_task_running,
        "liveBackgroundRunning": live_background_running,
        "companyId": company,
        "serverTime": time.strftime("%H:%M:%S"),
    }


ROLE_ALIASES = {
    "PL": ("项目负责人", "项目经理", "ceo"),
    "Analyst": ("需求分析", "需求分析师", "产品负责人"),
    "Designer": ("设计师", "前端设计师", "交互设计"),
    "Architect": ("架构师", "架构", "cto"),
    "Frontend": ("前端", "前端开发", "fe"),
    "Backend": ("后端", "后端开发", "be"),
    "QA": ("测试", "测试工程师", "质量负责人"),
    "DevOps": ("CICD", "CI/CD", "运维", "持续交付"),
}


def recipient_directory(agents):
    """只把已知角色别名映射到真实成员，不按当前 assignee 猜历史收件人。"""
    directory = {}
    for a in agents:
        endpoint = {"kind": "agent", "id": a["id"], "name": a.get("name") or "未知成员"}
        for alias in (a["id"], a.get("name"), *ROLE_ALIASES.get(a.get("name"), ())):
            if alias:
                directory[alias.casefold()] = endpoint
    for alias in ("用户", "所有者", "owner", "board"):
        directory[alias] = {"kind": "user", "id": None, "name": "用户"}
    return directory


def explicit_recipients(body, directory):
    """仅识别首行明确的收件指令，正文提及、引用和代码示例不算收件人。"""
    first = next((line.strip() for line in body.splitlines() if line.strip()), "")
    first = re.sub(r"^#{1,6}\s+", "", first).replace("**", "")
    match = re.match(
        r"^(?:(?:\[[^\]]{1,24}\]|【[^】]{1,24}】)\s*)?"
        r"(?:发送给|交接给|发给|交给|给|to\b)\s*[:：]?\s*(.+)$", first, re.I,
    )
    if not match:
        return []
    # “给 @PL — 下一步联系 @QA” 中，后半句不是本条消息的收件人。
    address = re.split(r"\s+-\s+|[—–:：。；;（(]", match[1], maxsplit=1)[0].strip()
    if address.casefold().lstrip("@") in directory:
        return [directory[address.casefold().lstrip("@")]]
    recipients = []
    for part in re.split(r"\s*(?:[、,，/&+＋]|\band\b|和|及|与)\s*|\s+(?=@)", address, flags=re.I):
        token = part.strip().rstrip("。.!！")
        mentioned = re.fullmatch(r"@([\w.-]+)", token)
        endpoint = directory.get(token.lstrip("@").casefold())
        if endpoint is None and mentioned:
            endpoint = {"kind": "mentioned", "id": None, "name": mentioned[1]}
        if endpoint and endpoint not in recipients:
            recipients.append(endpoint)
    return recipients


def comment_event(comment, issue, agent_id, directory):
    author = comment.get("authorAgentId") or comment.get("derivedAuthorAgentId")
    user = comment.get("authorUserId")
    if author:
        sender = directory.get(author.casefold(), {"kind": "agent", "id": author, "name": "未知成员"})
    elif user:
        sender = {"kind": "user", "id": user, "name": "用户"}
    else:
        sender = {"kind": "system", "id": None, "name": "系统"}
    body = comment.get("body") or ""
    recipients = explicit_recipients(body, directory)
    source = "explicit_header" if recipients else "issue_thread"
    if not recipients:
        recipients = [{"kind": "issue", "id": issue.get("id"), "name": f"{issue.get('identifier') or '任务'} 讨论区"}]
    direction = "out" if author == agent_id else "in" if any(
        r["kind"] == "agent" and r["id"] == agent_id for r in recipients
    ) else "related"
    return {
        "id": comment.get("id"),
        "ts": comment.get("createdAt"), "kind": "comment",
        "issue": issue.get("identifier"), "issueId": issue.get("id"),
        "issueTitle": issue.get("title"),
        "dir": direction, "agent": author, "user": user, "text": body,
        "sender": sender, "recipients": recipients, "recipientSource": source,
    }


def fetch_receipt_runs(company=None):
    company = company or COMPANY
    status, data = call("GET", f"/api/companies/{company}/heartbeat-runs?limit=200")
    if status != 200:
        return {"available": False, "runs": [], "limit": 200}
    if not isinstance(data, list) and not (
        isinstance(data, dict) and isinstance(data.get("runs"), list)
    ):
        return {"available": False, "runs": [], "limit": 200}
    return {"available": True, "runs": as_list(data, "runs"), "limit": 200}


def attach_receipts(events, snapshot, directory):
    """必须同时关联评论与任务；同任务的其他执行不充当该消息的回执。"""
    index = {}
    for run in snapshot["runs"]:
        context = run.get("contextSnapshot") or {}
        issue_ids = {context.get("issueId"), context.get("taskId")} - {None, ""}
        comment_ids = {context.get("commentId"), context.get("wakeCommentId")} - {None, ""}
        if not run.get("id") or not run.get("agentId") or len(issue_ids) != 1:
            continue
        issue_id = next(iter(issue_ids))
        for comment_id in comment_ids:
            receiver = directory.get(run["agentId"].casefold(), {"name": "未知成员"})
            index.setdefault((issue_id, comment_id), {})[run["id"]] = {
                "runId": run["id"], "agentId": run["agentId"], "agentName": receiver["name"],
                "status": run.get("status") or "unknown",
                "startedAt": run.get("startedAt"), "finishedAt": run.get("finishedAt"),
                "createdAt": run.get("createdAt"), "wakeReason": context.get("wakeReason"),
            }
    for event in events:
        if event["kind"] != "comment":
            continue
        matches = list(index.get((event.get("issueId"), event.get("id")), {}).values()) if event.get("id") else []
        matches.sort(key=lambda r: (r.get("createdAt") or r.get("startedAt") or "", r["runId"]), reverse=True)
        event["receipt"] = {
            "state": "matched" if matches else "not_found" if snapshot["available"] else "unavailable",
            "runs": matches,
            "scope": {"runLimit": snapshot["limit"], "runsFetched": len(snapshot["runs"]), "complete": False},
        }


def room_timeline(agent_id, limit_mine=6, limit_others=12, company=None):
    """合并自己发出、首行明确发给自己、以及当前名下任务的讨论。

    接收方来自原文收件指令；无法确定时只展示实际发布的讨论区。
    """
    company = company or COMPANY
    all_issues = fetch_issues(company)
    directory = recipient_directory(agents_for(company))
    mine = [i for i in all_issues if i.get("assigneeAgentId") == agent_id]
    others = [i for i in all_issues if i.get("assigneeAgentId") != agent_id]

    key = lambda x: x.get("updatedAt") or ""
    mine.sort(key=key, reverse=True)
    others.sort(key=key, reverse=True)
    mine = mine[:limit_mine]
    others = others[:limit_others]

    events = []
    mine_ids = {i.get("id") for i in mine}

    def push_issue(it):
        events.append({
            "ts": it.get("createdAt") or it.get("updatedAt"),
            "kind": "issue",
            "issue": it.get("identifier"),
            "issueId": it.get("id"),
            "status": it.get("status"),
            "title": it.get("title"),
            "mine": it.get("id") in mine_ids,
        })

    # 扫描仍然有界，但转派后的明确来信也纳入，不只搜索自己发出的评论。
    for it in mine + others:
        own_issue = it.get("id") in mine_ids
        included = own_issue
        if own_issue:
            push_issue(it)
        for c in fetch_comments(it.get("id")):
            if c.get("deletedAt"):
                continue
            event = comment_event(c, it, agent_id, directory)
            if not own_issue and event["dir"] not in ("in", "out"):
                continue
            if not included:
                push_issue(it)
                included = True
            events.append(event)

    events.sort(key=lambda e: e.get("ts") or "")
    events = events[-160:]
    attach_receipts(events, cached("receipt-runs:" + company, 4.0,
                                   lambda: fetch_receipt_runs(company)), directory)
    return {"agentId": agent_id, "events": events}


def public_text(value, limit=16000):
    """Only display content/tool fields; never select system prompts or reasoning columns."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    try:
        secret = api_key()
        if secret:
            text = text.replace(secret, "[已隐藏凭据]")
    except OSError:
        pass
    text = re.sub(r"(?i)(Bearer\s+)(?!\$)[A-Za-z0-9_.\-]{16,}", r"\1[已隐藏凭据]", text)
    text = re.sub(r'(?i)(["\']?(?:api[_-]?key|access[_-]?token|password|client_secret)["\']?\s*[:=]\s*["\']?)(?!\$)[A-Za-z0-9_./+\-=]{16,}', r'\1[已隐藏凭据]', text)
    return {"text": text[:limit], "truncated": len(text) > limit}


# ---------------------------------------------------------------- 任务进展

def checklist_progress(description, truncated=False):
    """任务描述里的 Markdown 勾选项；代码块中的示例不算进展。"""
    text = re.sub(r"```[\s\S]*?```", "", description or "")
    items = []
    for match in CHECKBOX_RE.finditer(text):
        items.append({
            "done": bool(match.group(1).strip()),
            "text": public_text(match.group(2).strip(), 200)["text"],
        })
    if not items:
        return None
    return {
        "done": sum(1 for item in items if item["done"]),
        "total": len(items),
        "items": items[:12],
        "more": max(0, len(items) - 12),
        "partial": bool(truncated),
    }


def task_run_index(company=None, member_runs=()):
    """团队最近 200 次与成员自己的运行窗口合并去重，按精确任务 ID 分组。"""
    company = company or COMPANY
    runs = cached("task-runs:" + company, 4.0, lambda: fetch_runs(company))
    index = {}
    seen = set()
    for run in [*member_runs, *runs]:
        if run.get("companyId") and run["companyId"] != company:
            continue
        run_id = run.get("id")
        if run_id and run_id in seen:
            continue
        context = run.get("contextSnapshot") or {}
        issue_id = context.get("issueId") or context.get("taskId")
        if issue_id:
            index.setdefault(issue_id, []).append(run)
            if run_id:
                seen.add(run_id)
    return index, len(runs)


def task_run_stats(runs):
    if not runs:
        return {"total": 0, "succeeded": 0, "failed": 0, "active": 0,
                "lastStatus": None, "lastAt": None, "lastError": ""}

    def when(run):
        return run.get("finishedAt") or run.get("startedAt") or run.get("createdAt") or ""

    ordered = sorted(runs, key=when, reverse=True)
    last = ordered[0]
    last_status = last.get("status")
    return {
        "total": len(runs),
        "succeeded": sum(1 for run in runs if run.get("status") == "succeeded"),
        "failed": sum(1 for run in runs if run.get("status") in ("failed", "timed_out")),
        "active": sum(1 for run in runs if run.get("status") in ("running", "queued")),
        "lastStatus": last_status,
        "lastAt": when(last) or None,
        "lastError": public_text(last.get("error") or "", 600)["text"]
        if last_status in ("failed", "timed_out") else "",
    }


def comment_author_name(comment, directory):
    agent_id = comment.get("authorAgentId") or comment.get("derivedAuthorAgentId")
    if agent_id:
        return directory.get(agent_id.casefold(), {}).get("name") or "未知成员"
    if comment.get("authorUserId") or comment.get("onBehalfOfUserId"):
        return "用户"
    return "系统"


def task_comments(issue_id, directory):
    comments = [c for c in fetch_comments(issue_id) if not c.get("deletedAt")]
    comments.sort(key=lambda c: c.get("createdAt") or "")
    latest = []
    for comment in comments[-3:]:
        preview = public_text(comment.get("body") or "", 400)
        latest.append({
            "id": comment.get("id"),
            "author": comment_author_name(comment, directory),
            "ts": comment.get("createdAt"),
            "text": preview["text"],
            "truncated": preview["truncated"],
        })
    return {"total": len(comments), "latest": latest}


def prefetch_comments(issue_ids):
    """任务面板要读多条评论；并发预取，避免首屏逐个等待。"""
    ids = [issue_id for issue_id in dict.fromkeys(issue_ids) if issue_id]
    if not ids:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(ids))) as pool:
        list(pool.map(fetch_comments, ids))


def participated_issues(agent_id, candidates, directory):
    """最近其他任务中，当前成员写过评论或被首行点名的那部分。"""
    found = []
    for issue in candidates:
        relation = None
        for comment in fetch_comments(issue.get("id")):
            if comment.get("deletedAt"):
                continue
            author = comment.get("authorAgentId") or comment.get("derivedAuthorAgentId")
            if author == agent_id:
                relation = "authored"
                break
            recipients = comment_event(comment, issue, agent_id, directory)["recipients"]
            if any(r.get("kind") == "agent" and r.get("id") == agent_id for r in recipients):
                relation = "addressed"
                break
        if relation:
            found.append((issue, relation))
    return found


def task_progress(issue, relation, issues_by_id, children_by_parent, run_index, directory):
    issue_id = issue.get("id")
    status = issue.get("status") or "todo"
    parent = issues_by_id.get(issue.get("parentId")) if issue.get("parentId") else None
    children = children_by_parent.get(issue_id, [])
    return {
        "id": issue_id,
        "identifier": issue.get("identifier"),
        "title": issue.get("title") or "",
        "status": status,
        "priority": issue.get("priority"),
        "phase": {"backlog": 0, "todo": 0, "in_progress": 1,
                  "in_review": 2, "done": 3}.get(status),
        "relation": relation,
        "createdAt": issue.get("createdAt"),
        "updatedAt": issue.get("updatedAt"),
        "lastActivityAt": issue.get("lastActivityAt") or issue.get("updatedAt") or issue.get("createdAt"),
        "completedAt": issue.get("completedAt"),
        "parent": None if not parent else {
            "identifier": parent.get("identifier"),
            "title": parent.get("title"),
            "status": parent.get("status"),
        },
        "children": {
            "total": len(children),
            "done": sum(1 for child in children if child.get("status") == "done"),
        },
        "checklist": checklist_progress(issue.get("description") or "",
                                        bool(issue.get("descriptionTruncated"))),
        "runs": task_run_stats(run_index.get(issue_id, [])),
        "attempts": [{
            "id": run.get("id"),
            "agentId": run.get("agentId"),
            "agentName": directory.get((run.get("agentId") or "").casefold(), {}).get("name") or "未知成员",
            "status": run.get("status"),
            "createdAt": run.get("createdAt"),
            "startedAt": run.get("startedAt"),
            "finishedAt": run.get("finishedAt"),
        } for run in run_index.get(issue_id, [])],
        "comments": task_comments(issue_id, directory) if issue_id else {"total": 0, "latest": []},
    }


def agent_tasks(agent_id, company=None):
    """名下未结/最近完成，加上有界窗口内参与讨论或实际执行过的任务。"""
    company = company or COMPANY
    agents = agents_for(company)
    agent = next((a for a in agents if a.get("id") == agent_id), None)
    if not agent:
        return {"agentId": agent_id, "state": "unavailable", "tasks": [], "note": "成员不存在。"}

    issues = fetch_issues(company)
    directory = recipient_directory(agents)
    member_window = fetch_agent_runs(agent_id, company)
    run_index, runs_fetched = task_run_index(company, member_window["runs"])
    executed = [issue for issue in issues if any(
        run.get("agentId") == agent_id for run in run_index.get(issue.get("id"), []))]
    assigned = [issue for issue in issues if issue.get("assigneeAgentId") == agent_id]
    open_tasks = [issue for issue in assigned if issue.get("status") not in ("done", "cancelled")]
    open_tasks.sort(key=lambda issue: issue.get("updatedAt") or "", reverse=True)
    open_tasks.sort(key=lambda issue: TASK_ORDER.get(issue.get("status"), 9))
    done_tasks = [issue for issue in assigned if issue.get("status") == "done"]
    done_tasks.sort(key=lambda issue: issue.get("updatedAt") or "", reverse=True)
    recent_done = done_tasks[:TASK_RECENT_DONE]

    candidates = [issue for issue in issues if issue.get("assigneeAgentId") != agent_id]
    candidates.sort(key=lambda issue: issue.get("updatedAt") or "", reverse=True)
    candidates = candidates[:TASK_PARTICIPATION_WINDOW]
    prefetch_comments([issue.get("id") for issue in open_tasks + recent_done + candidates + executed])

    shown = [(issue, "assigned") for issue in open_tasks + recent_done]
    assigned_ids = {issue.get("id") for issue in assigned}
    for issue, relation in participated_issues(agent_id, candidates, directory):
        if issue.get("id") not in assigned_ids:
            shown.append((issue, relation))

    shown_ids = {issue.get("id") for issue, _ in shown}
    executed_extra = [issue for issue in executed if issue.get("id") not in shown_ids]
    shown.extend((issue, "executed") for issue in executed_extra)
    issues_by_id = {issue.get("id"): issue for issue in issues}
    children = {}
    for issue in issues:
        if issue.get("parentId"):
            children.setdefault(issue["parentId"], []).append(issue)

    tasks = [task_progress(issue, relation, issues_by_id, children, run_index, directory)
             for issue, relation in shown]
    return {
        "agentId": agent_id,
        "agentName": agent.get("name"),
        "state": "available",
        "tasks": tasks,
        "groups": {
            "assigned": len(assigned),
            "open": len(open_tasks),
            "done": len(done_tasks),
            "doneShown": len(recent_done),
            "participated": len(shown) - len(open_tasks) - len(recent_done),
            "executed": len(executed_extra),
        },
        "counts": {"open": sum(1 for task in tasks
                              if task["status"] not in ("done", "cancelled"))},
        "scope": {
            "issueLimit": 100,
            "issuesFetched": len(issues),
            "runLimit": 200,
            "runsFetched": runs_fetched,
            "memberRunLimit": MEMBER_RUN_LIMIT,
            "memberRunsFetched": len(member_window["runs"]),
            "memberRunsAvailable": member_window["available"],
            "recentDone": TASK_RECENT_DONE,
            "participationWindow": TASK_PARTICIPATION_WINDOW,
        },
        "note": "当前任务查询范围内，包含名下未结、最近 4 项已完成、近期讨论参与及实际执行过的任务；运行记录合并团队最近 200 次与该成员最近 20 次，非完整历史。"
        + ("" if member_window["available"] else " 当前成员运行补查暂不可用，可能缺少较早执行记录。"),
    }


def decoded(value, fallback):
    try:
        return json.loads(value) if isinstance(value, str) else value if value is not None else fallback
    except (ValueError, TypeError):
        return fallback


def display_content(content):
    value = decoded(content, content)
    if isinstance(value, list):
        return "\n".join(str(item.get("text", "")) for item in value if isinstance(item, dict) and item.get("type") in ("text", "output_text"))
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def session_transcript(run, before=0, page_size=60, company=None):
    """Read-only Hermes messages, bounded by exact runtime identity and next wake boundary."""
    empty = {"entries": [], "nextCursor": None, "source": "hermes_session", "state": "unavailable"}
    if not HERMES_DB.is_file():
        return {**empty, "note": "Hermes 会话库不可用；仅展示平台运行结果。"}
    company = company or run.get("companyId") or COMPANY
    markers = [f"- Run ID: {run['id']}", f"- Agent ID: {run['agentId']}", f"- Company ID: {company}"]
    try:
        with closing(sqlite3.connect(HERMES_DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            # Prefix selection is only a candidate lookup. Exact complete lines below prove identity.
            candidates = db.execute("SELECT id,session_id,content FROM messages WHERE role='user' AND instr(content,?)>0 ORDER BY id DESC LIMIT 8", (markers[0],)).fetchall()
            matches = [row for row in candidates if all(m in row["content"].splitlines() for m in markers)]
            if len(matches) != 1:
                return {**empty, "state": "pending" if not matches else "unavailable", "note": "尚未找到精确关联的会话记录。" if not matches else "会话关联不唯一，未混用其他记录。"}
            start = matches[0]
            sid = start["session_id"]
            known_sid = run.get("sessionIdAfter")
            if known_sid and known_sid != sid:
                return {**empty, "note": "运行与会话标识不一致，未展示其他会话。"}
            following = db.execute("SELECT id FROM messages WHERE session_id=? AND role='user' AND id>? AND instr(content,'Paperclip runtime identity:')>0 ORDER BY id LIMIT 1", (sid, start["id"])).fetchone()
            end = following["id"] if following else 9223372036854775807
            if before and (before <= start["id"] or before > end):
                return {**empty, "note": "分页位置不属于本次运行，请重新加载。"}
            rows = db.execute("SELECT id,role,content,tool_calls,tool_call_id,tool_name,timestamp FROM messages WHERE session_id=? AND id>? AND id<? AND role IN ('assistant','tool') ORDER BY id DESC LIMIT ?", (sid, start["id"], min(before or end, end), page_size + 1)).fetchall()
            has_more = len(rows) > page_size
            rows = list(reversed(rows[:page_size]))
            entries = []
            for row in rows:
                ts = datetime.fromtimestamp(row["timestamp"], timezone.utc).isoformat()
                if row["role"] == "assistant":
                    text = display_content(row["content"] or "")
                    if text.strip():
                        entries.append({"id": f"m-{row['id']}", "kind": "assistant", "ts": ts, **public_text(text)})
                    calls = decoded(row["tool_calls"], [])
                    for index, tool in enumerate(calls if isinstance(calls, list) else []):
                        if not isinstance(tool, dict):
                            continue
                        function = tool.get("function") or {}
                        entries.append({"id": f"m-{row['id']}-t-{index}", "kind": "tool_call", "ts": ts, "toolCallId": tool.get("id") or tool.get("call_id"), "name": function.get("name") or "工具", **public_text(function.get("arguments") or "")})
                else:
                    result = decoded(row["content"], {})
                    is_error = isinstance(result, dict) and (bool(result.get("error")) or result.get("exit_code") not in (None, 0))
                    entries.append({"id": f"m-{row['id']}", "kind": "tool_result", "ts": ts, "toolCallId": row["tool_call_id"], "name": row["tool_name"], "isError": is_error, **public_text(display_content(row["content"] or ""))})
            return {"state": "available", "source": "hermes_session", "sessionId": sid, "entries": entries, "nextCursor": rows[0]["id"] if has_more else None, "note": "公开助手回复与工具记录；工具内容过长时明确标注截断。"}
    except (sqlite3.Error, ValueError, TypeError, OverflowError):
        return {**empty, "note": "会话库暂不可读，已保留平台运行结果，可稍后刷新。"}


def execution_run(run, before=0, company=None):
    company = company or run.get("companyId") or COMPANY
    context = run.get("contextSnapshot") or {}
    issue_id = context.get("issueId") or context.get("taskId")
    issue = next((i for i in fetch_issues(company) if i.get("id") == issue_id), {})
    result = run.get("resultJson") or {}
    summary = (result.get("result") or result.get("summary") or "") if isinstance(result, dict) else ""
    return {"id": run["id"], "agentId": run["agentId"], "status": run.get("status"), "ts": run.get("startedAt") or run.get("createdAt"), "finishedAt": run.get("finishedAt"), "issue": issue.get("identifier") or context.get("taskKey"), "issueTitle": issue.get("title") or "运行会话", "error": public_text(run.get("error") or "")["text"], "summary": public_text(summary), **session_transcript(run, before, company=company)}


def execution_timeline(agent_id, company=None):
    company = company or COMPANY
    if not any(a.get("id") == agent_id for a in agents_for(company)):
        return {"agentId": agent_id, "state": "unavailable", "runs": [], "note": "成员不存在。"}
    window = fetch_agent_runs(agent_id, company)
    if not window["available"]:
        return {"agentId": agent_id, "state": "unavailable", "runs": [], "note": "运行记录暂不可用。"}
    issues = fetch_issues(company)
    issue_ids = {issue.get("id") for issue in issues}
    runs = []
    for run in window["runs"]:
        context = run.get("contextSnapshot") or {}
        issue_id = context.get("issueId") or context.get("taskId")
        # 直接对话会话被 Paperclip 从普通任务列表隐藏；它的运行也不应混入任务时间线。
        if issue_id not in issue_ids:
            continue
        runs.append(run)
    return {"agentId": agent_id, "state": "available", "runs": [execution_run(run, company=company) for run in runs[:4]], "note": "展示当前成员最近 4 次任务运行，按原始会话顺序展示公开输出。"}


def invalidate_task_caches():
    """新建/评论后让任务与状态缓存立即失效，避免面板要等 4 秒才出现。"""
    for key in list(_CACHE):
        if key.startswith(("issues:", "tasks:", "agents:")):
            _CACHE.pop(key, None)


def create_task(company, agent_id, title, description="", priority="medium"):
    company = company or COMPANY
    if not any(agent.get("id") == agent_id for agent in agents_for(company)):
        return {"ok": False, "error": "成员不存在。"}
    lines = (title or "").strip().splitlines()
    clean_title = lines[0].strip()[:200] if lines else ""
    if not clean_title:
        return {"ok": False, "error": "任务标题不能为空。"}
    payload = {
        "title": clean_title,
        "description": (description or "").strip()[:20000],
        "assigneeAgentId": agent_id,
        "status": "todo",
    }
    if priority in TASK_PRIORITIES:
        payload["priority"] = priority
    st, data = call("POST", f"/api/companies/{company}/issues", payload)
    if st in (200, 201) and isinstance(data, dict):
        invalidate_task_caches()
        return {"ok": True, "id": data.get("id"), "issue": data.get("identifier"),
                "status": data.get("status"), "priority": data.get("priority")}
    return {"ok": False,
            "error": f"建单失败 HTTP {st}: {json.dumps(data, ensure_ascii=False)[:200]}"}


def send_message(agent_id, text, company=None):
    """有在办任务就追加评论（会唤醒 agent），否则新建任务派给它。"""
    company = company or COMPANY
    mine = [i for i in fetch_issues(company) if i.get("assigneeAgentId") == agent_id]
    mine.sort(key=lambda x: (x.get("status") != "in_progress", x.get("updatedAt") or ""), )
    target = None
    for it in mine:
        if it.get("status") in ("in_progress", "todo"):
            target = it
            break

    if target:
        st, _ = call("POST", f"/api/issues/{target['id']}/comments", {"body": text})
        if st in (200, 201):
            return {"ok": True, "mode": "comment", "issue": target.get("identifier")}
        return {"ok": False, "error": f"评论失败 HTTP {st}"}

    st, data = call("POST", f"/api/companies/{company}/issues", {
        "title": text.strip().splitlines()[0][:80],
        "description": text,
        "assigneeAgentId": agent_id,
        "status": "todo",
    })
    if st in (200, 201):
        invalidate_task_caches()
        return {"ok": True, "mode": "new-issue",
                "issue": (data or {}).get("identifier")}
    return {"ok": False, "error": f"建单失败 HTTP {st}: {json.dumps(data, ensure_ascii=False)[:200]}"}


def _chat_agent(company, agent_id):
    agents = agents_for(company)
    agent = next((a for a in agents if a.get("id") == agent_id), None)
    return agent, agents


def _chat_disabled(status, data):
    return status == 404 and isinstance(data, dict) and "Agent Chat is disabled" in str(data.get("error") or "")


def chat_messages(issue_id, directory):
    status, data = call("GET", f"/api/issues/{issue_id}/comments?order=asc")
    if status != 200:
        return None
    messages = []
    for comment in as_list(data, "comments"):
        if comment.get("deletedAt"):
            continue
        body = comment.get("body") or ""
        if not body.strip():
            continue
        author_id = comment.get("authorAgentId") or comment.get("derivedAuthorAgentId")
        user_id = comment.get("authorUserId") or comment.get("onBehalfOfUserId")
        if author_id:
            author, name = "agent", directory.get(author_id.casefold(), {}).get("name") or "成员"
        elif user_id:
            author, name = "user", "我"
        else:
            author, name = "system", "系统"
        preview = public_text(body)
        messages.append({
            "id": comment.get("id"),
            "author": author,
            "authorName": name,
            "ts": comment.get("createdAt"),
            "text": preview["text"],
            "truncated": preview["truncated"],
        })
    messages.sort(key=lambda item: item.get("ts") or "")
    return messages


def chat_snapshot(company, agent_id):
    agent, agents = _chat_agent(company, agent_id)
    if not agent:
        return {"agentId": agent_id, "state": "unavailable", "messages": [], "note": "成员不存在。"}
    status, data = call("GET", f"/api/companies/{company}/chats/{quote(agent_id, safe='')}")
    if _chat_disabled(status, data):
        return {"agentId": agent_id, "agentName": agent.get("name"), "state": "disabled",
                "messages": [], "note": "Paperclip 实例尚未启用 Agent Chat。"}
    if status != 200:
        return {"agentId": agent_id, "agentName": agent.get("name"), "state": "unavailable",
                "messages": [], "note": f"对话记录暂不可用（HTTP {status}）。"}
    if not data:
        return {"agentId": agent_id, "agentName": agent.get("name"), "state": "new",
                "chat": None, "messages": [], "note": "还没有对话，发送第一条消息即可开始。"}
    if data.get("companyId") != company or data.get("conversationAgentId") != agent_id:
        return {"agentId": agent_id, "agentName": agent.get("name"), "state": "unavailable",
                "messages": [], "note": "对话归属与当前团队不一致。"}
    messages = chat_messages(data.get("id"), recipient_directory(agents))
    if messages is None:
        return {"agentId": agent_id, "agentName": agent.get("name"), "state": "unavailable",
                "chat": {"id": data.get("id")}, "messages": [], "note": "对话消息暂不可用。"}
    return {
        "agentId": agent_id,
        "agentName": agent.get("name"),
        "state": "available",
        "chat": {
            "id": data.get("id"),
            "identifier": data.get("identifier"),
            "title": data.get("title"),
            "status": data.get("status"),
            "conversationState": data.get("conversationState"),
            "lastActivityAt": data.get("lastActivityAt") or data.get("updatedAt"),
        },
        "messages": messages,
        "note": "直接对话；消息会唤醒成员，不创建任务。",
    }


def send_chat(company, agent_id, text):
    agent, _ = _chat_agent(company, agent_id)
    if not agent:
        return {"ok": False, "state": "unavailable", "error": "成员不存在。"}
    status, chat = call("GET", f"/api/companies/{company}/chats/{quote(agent_id, safe='')}")
    if _chat_disabled(status, chat):
        return {"ok": False, "state": "disabled", "error": "Paperclip 实例尚未启用 Agent Chat。"}
    if status != 200:
        return {"ok": False, "error": f"读取对话失败 HTTP {status}"}
    if not chat:
        status, chat = call("POST", f"/api/companies/{company}/chats/{quote(agent_id, safe='')}", {})
        if status not in (200, 201) or not isinstance(chat, dict):
            return {"ok": False, "error": f"创建对话失败 HTTP {status}"}
    if chat.get("companyId") != company or chat.get("conversationAgentId") != agent_id:
        return {"ok": False, "error": "对话归属与当前团队不一致。"}
    comment = {"body": text, "clientRequestId": str(uuid.uuid4())}
    status, saved = call("POST", f"/api/issues/{chat['id']}/comments", comment)
    if status in (200, 201):
        return {"ok": True, "chatId": chat.get("id"), "identifier": chat.get("identifier"),
                "commentId": saved.get("id") if isinstance(saved, dict) else None}
    return {"ok": False,
            "error": f"发送失败 HTTP {status}: {json.dumps(saved, ensure_ascii=False)[:180]}"}


def set_model(agent_id, model):
    st, data = call("GET", f"/api/agents/{agent_id}")
    if st != 200:
        return {"ok": False, "error": f"读 agent 失败 HTTP {st}"}
    cfg = dict((data or {}).get("adapterConfig") or {})
    cfg["model"] = model
    st2, d2 = call("PATCH", f"/api/agents/{agent_id}", {"adapterConfig": cfg})
    if st2 in (200, 201):
        return {"ok": True, "model": model}
    return {"ok": False, "error": f"HTTP {st2}: {json.dumps(d2, ensure_ascii=False)[:200]}"}


# ---------------------------------------------------------------- HTTP 层

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[room] " + (fmt % args) + "\n")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except Exception:
            return {}

    def _company(self, query, body=None):
        raw = (body or {}).get("company") or (query.get("company") or [""])[0]
        return resolve_company(raw)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        query = parse_qs(u.query)

        if p in ("/", "/index.html"):
            return self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")

        if p == "/api/teams":
            try:
                return self._send(200, teams_payload())
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if p == "/api/state":
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            try:
                return self._send(200, agent_snapshot(company))
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if p == "/api/tasks":
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid = (query.get("agent") or [""])[0]
            if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", aid):
                return self._send(400, {"error": "valid agent required"})
            try:
                return self._send(200, cached("tasks:" + company + ":" + aid, 4.0,
                                               lambda: agent_tasks(aid, company)))
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if p == "/api/chat":
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid = (query.get("agent") or [""])[0]
            if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", aid):
                return self._send(400, {"error": "valid agent required"})
            try:
                return self._send(200, chat_snapshot(company, aid))
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if p == "/api/room":
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid = (query.get("agent") or [""])[0]
            if not aid:
                return self._send(400, {"error": "agent required"})
            try:
                return self._send(200, room_timeline(aid, company=company))
            except Exception as e:
                return self._send(500, {"error": str(e)})

        if p in ("/api/execution", "/api/run"):
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid = (query.get("agent") or [""])[0]
            if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", aid):
                return self._send(400, {"error": "valid agent required"})
            try:
                if p == "/api/execution":
                    return self._send(200, cached("exec:" + company + ":" + aid, 4,
                                                  lambda: execution_timeline(aid, company)))
                rid = (query.get("run") or [""])[0]
                before = int((query.get("before") or ["0"])[0])
                if not re.fullmatch(r"[0-9a-fA-F-]{36}", rid) or before < 0:
                    return self._send(400, {"error": "valid run and cursor required"})
                status, run = call("GET", "/api/heartbeat-runs/" + rid)
                if status != 200 or not isinstance(run, dict) or run.get("companyId") != company or run.get("agentId") != aid:
                    return self._send(404, {"error": "run not found for this member"})
                return self._send(200, execution_run(run, before, company))
            except ValueError:
                return self._send(400, {"error": "invalid cursor"})
            except Exception as e:
                return self._send(500, {"error": str(e)})

        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        query = parse_qs(u.query)
        body = self._json_body()

        if u.path == "/api/tasks":
            company = self._company(query, body)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid, title = body.get("agentId"), (body.get("title") or "").strip()
            if not aid or not title:
                return self._send(400, {"error": "agentId and title required"})
            return self._send(200, create_task(
                company, aid, title,
                description=body.get("description") or "",
                priority=(body.get("priority") or "medium"),
            ))

        if u.path == "/api/chat":
            company = self._company(query, body)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid, text = body.get("agentId"), (body.get("text") or "").strip()
            if not aid or not text:
                return self._send(400, {"error": "agentId and text required"})
            return self._send(200, send_chat(company, aid, text))

        if u.path == "/api/send":
            company = self._company(query, body)
            if not company:
                return self._send(404, {"error": "team not found"})
            aid, text = body.get("agentId"), (body.get("text") or "").strip()
            if not aid or not text:
                return self._send(400, {"error": "agentId and text required"})
            return self._send(200, send_message(aid, text, company))

        if u.path == "/api/model":
            aid, model = body.get("agentId"), (body.get("model") or "").strip()
            if not aid or not model:
                return self._send(400, {"error": "agentId and model required"})
            return self._send(200, set_model(aid, model))

        return self._send(404, {"error": "not found"})


def main():
    if not COMPANY:
        raise SystemExit("请设置 PAPERCLIP_COMPANY（Paperclip 公司 ID），配置方式见 README.md。")
    if not KEY_FILE.is_file() or not api_key():
        raise SystemExit("PAPERCLIP_KEY_FILE 必须指向非空的授权密钥文件，配置方式见 README.md。")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[room] http://{HOST}:{PORT}  company={COMPANY}  paperclip={PAPERCLIP}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
