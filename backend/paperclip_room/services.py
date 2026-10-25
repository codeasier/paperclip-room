#!/usr/bin/env python3
"""Application services: bounded Paperclip aggregation and read-only Hermes transcripts."""
import json
import os
import re
import sqlite3
import time
import uuid
from urllib.parse import quote
from datetime import datetime, timezone
from contextlib import closing
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from .config import COMPANY, HERMES_DB
from .client import api_key, call

# 这些状态算"在办"，发消息时优先挂到这种任务上
OPEN_STATES = ("in_progress", "in_review", "todo", "blocked")

# 任务进展面板：排序、最近完成数量、参与任务扫描窗口
TASK_ORDER = {"in_progress": 0, "blocked": 1, "in_review": 2, "todo": 3, "backlog": 4}
TASK_RECENT_DONE = 4
TASK_PARTICIPATION_WINDOW = 12
MEMBER_RUN_LIMIT = 20
TASK_PRIORITIES = ("low", "medium", "high", "critical")
CHECKBOX_RE = re.compile(r"^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$", re.M)


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
    task_key = context.get("taskKey")
    # 有的运行把内部 issue UUID 当 taskKey 写进来，直接展示会变成一串 UUID
    if isinstance(task_key, str) and re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", task_key):
        task_key = None
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
        "taskKey": task_key,
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


CHAT_ACTIVITY_STEPS = 10
CHAT_ACTIVITY_TTL = 2.0


def _activity_text(row, key):
    """老库可能缺列；缺列按空值处理，不让一次读取失败。"""
    return row[key] if key in row.keys() else None


def _redact_activity(text):
    """命令和思考里可能带令牌前缀；先挡一层，其余交给 public_text 的通用规则。"""
    text = re.sub(r"\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})", "[已隐藏凭据]", text)
    return re.sub(r"\bsk-[A-Za-z0-9_-]{16,}", "[已隐藏凭据]", text)


def _tool_command(arguments):
    """终端调用只展示命令本身，避免把整段参数 JSON 摊在界面上。"""
    value = decoded(arguments, None)
    if isinstance(value, dict) and isinstance(value.get("command"), str):
        return value["command"]
    return arguments if isinstance(arguments, str) else json.dumps(value, ensure_ascii=False)


def _tool_output(content):
    """工具结果是 {"output": ...} 这类包装时只取正文，别把 JSON 外壳摊给用户。"""
    value = decoded(content, None)
    if isinstance(value, dict):
        for key in ("output", "stdout", "result"):
            text = value.get(key)
            if isinstance(text, str) and text.strip():
                return text
        if value.get("error"):
            error = value["error"]
            return error if isinstance(error, str) else json.dumps(error, ensure_ascii=False)
    return display_content(content or "")


def _session_tail(run, limit):
    """按 Paperclip 记录的会话标识读取本次运行窗口；找不到会话返回 None。"""
    sid = run.get("sessionIdAfter")
    if not sid or not HERMES_DB.is_file():
        return None
    start = _ts(run.get("startedAt") or run.get("createdAt")) - 2
    finish = _ts(run.get("finishedAt"))
    end = finish + 2 if finish else time.time() + 5
    try:
        with closing(sqlite3.connect(HERMES_DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT id,role,content,tool_calls,tool_name,reasoning,reasoning_content,timestamp"
                " FROM messages WHERE session_id=? AND role IN ('assistant','tool')"
                " AND timestamp>=? AND timestamp<=? ORDER BY id DESC LIMIT ?",
                (sid, start, end, limit),
            ).fetchall()
    except (sqlite3.Error, ValueError, TypeError, OverflowError):
        return None
    return list(reversed(rows))


def chat_activity(run):
    """对话回合进行中的实时步骤：思考、工具调用与输出。

    只读本次运行窗口内的会话记录，不做跨运行推断；读不到就明确说读不到。
    """
    def _load():
        rows = _session_tail(run, CHAT_ACTIVITY_STEPS * 2)
        if rows is None:
            return {"state": "unavailable", "steps": [], "note": "会话库不可读，暂时只能看运行状态与耗时。"}
        if not rows:
            return {"state": "pending", "steps": [], "note": "这一轮还没有可读的助手或工具记录。"}
        steps = []
        for row in rows:
            ts = datetime.fromtimestamp(row["timestamp"], timezone.utc).isoformat()
            if row["role"] == "assistant":
                reasoning = (_activity_text(row, "reasoning") or _activity_text(row, "reasoning_content") or "").strip()
                if reasoning:
                    steps.append({"id": f"r-{row['id']}", "kind": "thinking", "ts": ts,
                                  **public_text(_redact_activity(reasoning), 400)})
                text = display_content(row["content"] or "")
                if text.strip():
                    steps.append({"id": f"m-{row['id']}", "kind": "assistant", "ts": ts,
                                  **public_text(text, 600)})
                calls = decoded(row["tool_calls"], [])
                for index, tool in enumerate(calls if isinstance(calls, list) else []):
                    if not isinstance(tool, dict):
                        continue
                    function = tool.get("function") or {}
                    steps.append({
                        "id": f"m-{row['id']}-t-{index}", "kind": "tool_call", "ts": ts,
                        "name": function.get("name") or "工具",
                        "toolCallId": tool.get("id") or tool.get("call_id"),
                        **public_text(_redact_activity(_tool_command(function.get("arguments") or "")), 300),
                    })
                continue
            result = decoded(row["content"], {})
            is_error = isinstance(result, dict) and (
                bool(result.get("error")) or result.get("exit_code") not in (None, 0)
            )
            steps.append({"id": f"t-{row['id']}", "kind": "tool_result", "ts": ts,
                          "name": row["tool_name"], "isError": is_error,
                          **public_text(_redact_activity(_tool_output(row["content"] or "")), 240)})
        return {"state": "available", "steps": steps[-CHAT_ACTIVITY_STEPS:],
                "note": "来自 Hermes 会话的实时步骤；思考与输出过长时截断。"}
    key = "chat-activity:" + str(run.get("id")) + ":" + str(run.get("sessionIdAfter"))
    return cached(key, CHAT_ACTIVITY_TTL, _load)


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


# ---------------------------------------------------------------- 成员属性（member-config）

MEMBER_CONFIG_KEYS = ("model", "timeoutSec", "maxConcurrentRuns", "name", "title", "instructions")
MEMBER_TIMEOUT_MIN = 1200
MEMBER_CONCURRENT_MAX = 8
MEMBER_CONCURRENT_PLATFORM_DEFAULT = 20
MEMBER_INSTRUCTIONS_MAX_BYTES = 256 * 1024
MEMBER_CONCURRENT_WARNING = "超出控制台建议上限，保存前请调到 ≤8"
MEMBER_WORKDIR_KEYS = ("cwd", "workingDirectory", "workDir", "workspacePath", "workspace")
INSTRUCTIONS_ENTRY_DEFAULT = "AGENTS.md"


def invalidate_member_caches(company):
    """写成功后失效 agents / ops 相关缓存，保证一轮询内可见。"""
    for key in list(_CACHE):
        if key == "agents:" + company or key.startswith("agents:" + company + ":"):
            _CACHE.pop(key, None)
        elif key.startswith("ops:") and (key.endswith(":" + company) or (":" + company + ":") in key or key == "ops:" + company):
            _CACHE.pop(key, None)


def _shanghai_now_iso():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _runtime_from_agent(agent):
    """归一 runtime 展示：timeout 缺省 null；并发缺键展示平台默认 20；>8 带回真实值+warning。"""
    cfg = agent.get("adapterConfig") or {}
    rc = agent.get("runtimeConfig") or {}
    heartbeat = rc.get("heartbeat") if isinstance(rc.get("heartbeat"), dict) else {}
    timeout = cfg.get("timeoutSec")
    if timeout is not None:
        try:
            timeout = int(timeout)
        except (TypeError, ValueError):
            timeout = None
    raw_concurrent = heartbeat.get("maxConcurrentRuns") if isinstance(heartbeat, dict) else None
    capped = False
    warning = None
    if raw_concurrent is None:
        concurrent = MEMBER_CONCURRENT_PLATFORM_DEFAULT
    else:
        try:
            concurrent = int(raw_concurrent)
        except (TypeError, ValueError):
            concurrent = MEMBER_CONCURRENT_PLATFORM_DEFAULT
            raw_concurrent = None
        else:
            if concurrent > MEMBER_CONCURRENT_MAX:
                warning = MEMBER_CONCURRENT_WARNING
                capped = False
    return {
        "model": cfg.get("model"),
        "timeoutSec": timeout,
        "maxConcurrentRuns": concurrent,
        "maxConcurrentRunsPlatformDefault": MEMBER_CONCURRENT_PLATFORM_DEFAULT,
        "maxConcurrentRunsCapped": capped,
        "warning": warning,
        "_rawMaxConcurrentRuns": raw_concurrent,
    }


def probe_instructions(agent_id, agent=None):
    """探测 instructions：bundle 入口 → promptTemplate → unavailable。

    返回 identity.instructions 形状；写前可再次调用。mode∈writable|readonly|unavailable。
    """
    agent = agent or {}
    bundle_st, bundle = call("GET", f"/api/agents/{agent_id}/instructions-bundle")
    entry = INSTRUCTIONS_ENTRY_DEFAULT
    if bundle_st == 200 and isinstance(bundle, dict):
        entry = bundle.get("entryFile") or bundle.get("entry") or entry
        file_st, file_data = call(
            "GET", f"/api/agents/{agent_id}/instructions-bundle/file?path={quote(entry, safe='/')}"
        )
        if file_st == 200 and isinstance(file_data, dict):
            content = file_data.get("content")
            if content is None:
                content = ""
            # board token 默认可写；403/策略位 → readonly
            mode = "writable"
            if file_data.get("writable") is False or bundle.get("writable") is False:
                mode = "readonly"
            if bundle.get("mode") == "readonly" or file_data.get("mode") == "readonly":
                mode = "readonly"
            return {
                "mode": mode,
                "source": "bundle",
                "path": entry,
                "content": content if isinstance(content, str) else str(content),
                "contentHash": file_data.get("contentHash") or file_data.get("baseHash"),
                "probeNote": None,
            }
        if file_st in (401, 403):
            return {
                "mode": "readonly",
                "source": "bundle",
                "path": entry,
                "content": "",
                "contentHash": None,
                "probeNote": f"instructions-bundle 不可写（HTTP {file_st}）",
            }
        if file_st == 404 and bundle_st == 200:
            # bundle 存在但入口空：仍可按可写空文件处理
            return {
                "mode": "writable",
                "source": "bundle",
                "path": entry,
                "content": "",
                "contentHash": None,
                "probeNote": "入口文件尚不存在，保存时将创建",
            }
    cfg = (agent.get("adapterConfig") if agent else None) or {}
    if not cfg and agent_id:
        st, data = call("GET", f"/api/agents/{agent_id}")
        if st == 200 and isinstance(data, dict):
            cfg = data.get("adapterConfig") or {}
            agent = data
    prompt = cfg.get("promptTemplate")
    if isinstance(prompt, str):
        return {
            "mode": "writable",
            "source": "promptTemplate",
            "path": None,
            "content": prompt,
            "contentHash": None,
            "probeNote": None,
        }
    note = "无 instructions-bundle，也无 adapterConfig.promptTemplate"
    if bundle_st not in (200, 404):
        note = f"instructions-bundle 探测失败 HTTP {bundle_st}"
    return {
        "mode": "unavailable",
        "source": None,
        "path": None,
        "content": "",
        "contentHash": None,
        "probeNote": note,
    }


def _agent_workdir(agent):
    """仅当配置里已有本机可读工作目录类字段时返回 Path；禁止猜路径。"""
    cfg = agent.get("adapterConfig") or {}
    for key in MEMBER_WORKDIR_KEYS:
        value = cfg.get(key)
        if isinstance(value, str) and value.strip():
            path = Path(value).expanduser()
            try:
                if path.is_dir():
                    return path
            except OSError:
                continue
    return None


def _memory_session_reuse(company, agent_id, agent):
    as_of = _shanghai_now_iso()
    cfg = agent.get("adapterConfig") or {}
    persist = cfg.get("persistSession")
    window = fetch_agent_runs(agent_id, company)
    runs = window.get("runs") or [] if isinstance(window, dict) else []
    sessions = []
    latest_ts = None
    for run in runs:
        sid = run.get("sessionIdAfter")
        if sid:
            sessions.append(sid)
        ts = run.get("finishedAt") or run.get("startedAt") or run.get("createdAt")
        if ts and (latest_ts is None or _ts(ts) > _ts(latest_ts)):
            latest_ts = ts
    detail_bits = []
    if persist is True:
        detail_bits.append("配置意图 persistSession=true")
    elif persist is False:
        detail_bits.append("配置意图 persistSession=false")
    if not sessions:
        return {
            "state": "unknown",
            "detail": "；".join(detail_bits + ["近期运行无 sessionIdAfter"]) or "近期运行无 sessionIdAfter",
            "source": "heartbeat-runs.sessionIdAfter",
            "asOf": latest_ts or as_of,
        }
    unique = list(dict.fromkeys(sessions))
    if len(sessions) >= 2 and sessions[0] == sessions[1]:
        state = "reused"
        detail_bits.append(f"最近两次运行共用 session {sessions[0][:12]}…")
    elif len(unique) == 1 and len(sessions) >= 2:
        state = "reused"
        detail_bits.append(f"窗口内复用同一 session {unique[0][:12]}…")
    elif len(unique) == len(sessions) and len(sessions) >= 2:
        state = "fresh"
        detail_bits.append("窗口内各次运行 session 均不同")
    else:
        state = "unknown"
        detail_bits.append(f"可见 {len(sessions)} 条 session 线索")
    return {
        "state": state,
        "detail": "；".join(detail_bits),
        "source": "heartbeat-runs.sessionIdAfter",
        "asOf": latest_ts or as_of,
    }


def _memory_handoff(agent):
    as_of = _shanghai_now_iso()
    root = _agent_workdir(agent)
    if root is None:
        return {
            "state": "unavailable",
            "files": [],
            "source": "adapterConfig.workdir",
            "asOf": as_of,
            "detail": "成员配置无可读工作目录，未扫描磁盘",
        }
    handoff = root / ".handoff"
    try:
        if not handoff.is_dir():
            return {
                "state": "empty",
                "files": [],
                "source": str(handoff),
                "asOf": as_of,
            }
        files = []
        for item in sorted(handoff.iterdir(), key=lambda p: p.name):
            if not item.is_file():
                continue
            try:
                mtime = datetime.fromtimestamp(item.stat().st_mtime, timezone.utc).isoformat()
            except OSError:
                mtime = None
            files.append({"path": f".handoff/{item.name}", "mtime": mtime})
        return {
            "state": "available" if files else "empty",
            "files": files[:50],
            "source": str(handoff),
            "asOf": as_of,
        }
    except OSError:
        return {
            "state": "unavailable",
            "files": [],
            "source": str(handoff),
            "asOf": as_of,
            "detail": "无法读取 .handoff 目录",
        }


def _memory_context_size(company, agent_id):
    as_of = _shanghai_now_iso()
    empty = {
        "state": "unavailable",
        "approxChars": None,
        "unit": "chars",
        "source": "HERMES_DB",
        "asOf": as_of,
    }
    if not HERMES_DB.is_file():
        return {**empty, "detail": "Hermes 会话库不可用"}
    window = fetch_agent_runs(agent_id, company)
    runs = window.get("runs") or [] if isinstance(window, dict) else []
    sid = None
    for run in runs:
        if run.get("sessionIdAfter"):
            sid = run["sessionIdAfter"]
            break
    if not sid:
        return {**empty, "state": "empty", "detail": "近期运行无关联 session"}
    try:
        with closing(sqlite3.connect(HERMES_DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            row = db.execute(
                "SELECT COALESCE(SUM(LENGTH(COALESCE(content,''))),0) FROM messages WHERE session_id=?",
                (sid,),
            ).fetchone()
            total = int(row[0]) if row else 0
        return {
            "state": "available" if total else "empty",
            "approxChars": total,
            "unit": "chars",
            "source": "HERMES_DB",
            "asOf": as_of,
        }
    except (sqlite3.Error, TypeError, ValueError, OSError):
        return {**empty, "detail": "会话库暂不可读"}


def member_memory(company, agent_id, agent):
    """P2 记忆只读三块；任一块失败局部 unavailable，不拖垮整页。"""
    try:
        session_reuse = _memory_session_reuse(company, agent_id, agent)
    except Exception:
        session_reuse = {
            "state": "unavailable", "detail": "会话复用探测失败",
            "source": "heartbeat-runs", "asOf": _shanghai_now_iso(),
        }
    try:
        handoff = _memory_handoff(agent)
    except Exception:
        handoff = {
            "state": "unavailable", "files": [], "source": "adapterConfig.workdir",
            "asOf": _shanghai_now_iso(),
        }
    try:
        context_size = _memory_context_size(company, agent_id)
    except Exception:
        context_size = {
            "state": "unavailable", "approxChars": None, "unit": "chars",
            "source": "HERMES_DB", "asOf": _shanghai_now_iso(),
        }
    return {
        "sessionReuse": session_reuse,
        "handoff": handoff,
        "contextSize": context_size,
    }


def get_member_config(company, agent_id):
    """GET /api/member-config 聚合：runtime + identity + memory。"""
    if not any(a.get("id") == agent_id for a in agents_for(company)):
        return None
    st, agent = call("GET", f"/api/agents/{agent_id}")
    if st != 200 or not isinstance(agent, dict):
        return {"ok": False, "error": f"读 agent 失败 HTTP {st}", "httpStatus": 502 if st >= 500 or st == 599 else 404}
    runtime = _runtime_from_agent(agent)
    runtime.pop("_rawMaxConcurrentRuns", None)
    instructions = probe_instructions(agent_id, agent)
    # 对外不暴露 contentHash（内部写用）；GET 形状按契约
    public_instructions = {
        "mode": instructions["mode"],
        "source": instructions.get("source"),
        "path": instructions.get("path"),
        "content": instructions.get("content") or "",
        "probeNote": instructions.get("probeNote"),
    }
    return {
        "agentId": agent_id,
        "companyId": company,
        "fetchedAt": _shanghai_now_iso(),
        "runtime": runtime,
        "identity": {
            "name": agent.get("name"),
            "title": agent.get("title") if agent.get("title") is not None else "",
            "instructions": public_instructions,
        },
        "memory": member_memory(company, agent_id, agent),
        "_instructionsMeta": instructions,
    }


def validate_member_fields(fields):
    """白名单值域校验。成功返回 (cleaned, None)；失败返回 (None, {ok,error,field})。"""
    if not isinstance(fields, dict):
        return None, {"ok": False, "error": "请求体须为对象", "field": None}
    unknown = [k for k in fields if k not in MEMBER_CONFIG_KEYS]
    if unknown:
        return None, {"ok": False, "error": f"未知字段：{', '.join(unknown)}", "field": unknown[0]}
    if not fields:
        return None, {"ok": False, "error": "没有需要保存的更改", "field": None}
    cleaned = {}
    if "model" in fields:
        model = fields["model"]
        if not isinstance(model, str) or not model.strip() or len(model.strip()) > 128:
            return None, {"ok": False, "error": "请选择或填写模型", "field": "model"}
        cleaned["model"] = model.strip()
    if "timeoutSec" in fields:
        try:
            if isinstance(fields["timeoutSec"], bool):
                raise TypeError
            timeout = int(fields["timeoutSec"])
        except (TypeError, ValueError):
            return None, {"ok": False, "error": "超时须 ≥ 1200 秒（与巡检一致）", "field": "timeoutSec"}
        if timeout < MEMBER_TIMEOUT_MIN:
            return None, {"ok": False, "error": "超时须 ≥ 1200 秒（与巡检一致）", "field": "timeoutSec"}
        cleaned["timeoutSec"] = timeout
    if "maxConcurrentRuns" in fields:
        try:
            if isinstance(fields["maxConcurrentRuns"], bool):
                raise TypeError
            concurrent = int(fields["maxConcurrentRuns"])
        except (TypeError, ValueError):
            return None, {"ok": False, "error": "并发须为 0–8 的整数", "field": "maxConcurrentRuns"}
        if concurrent < 0 or concurrent > MEMBER_CONCURRENT_MAX:
            return None, {"ok": False, "error": "并发须为 0–8 的整数", "field": "maxConcurrentRuns"}
        cleaned["maxConcurrentRuns"] = concurrent
    if "name" in fields:
        name = fields["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 64:
            return None, {"ok": False, "error": "名称不能为空", "field": "name"}
        cleaned["name"] = name.strip()
    if "title" in fields:
        title = fields["title"]
        if not isinstance(title, str) or len(title) > 128:
            return None, {"ok": False, "error": "title 过长", "field": "title"}
        cleaned["title"] = title
    if "instructions" in fields:
        instructions = fields["instructions"]
        if not isinstance(instructions, str):
            return None, {"ok": False, "error": "instructions 须为字符串", "field": "instructions"}
        if len(instructions.encode("utf-8")) > MEMBER_INSTRUCTIONS_MAX_BYTES:
            return None, {"ok": False, "error": "instructions 过长（上限 256KiB）", "field": "instructions"}
        cleaned["instructions"] = instructions
    return cleaned, None


def _write_instructions(agent_id, content, probe):
    """按探测来源写入；不可写由调用方先拦。"""
    if probe.get("source") == "bundle":
        path = probe.get("path") or INSTRUCTIONS_ENTRY_DEFAULT
        body = {"path": path, "content": content, "baseHash": probe.get("contentHash")}
        st, data = call("PUT", f"/api/agents/{agent_id}/instructions-bundle/file", body)
        if st in (200, 201):
            return True, None
        return False, f"写 instructions-bundle 失败 HTTP {st}: {json.dumps(data, ensure_ascii=False)[:180]}"
    if probe.get("source") == "promptTemplate":
        st, agent = call("GET", f"/api/agents/{agent_id}")
        if st != 200 or not isinstance(agent, dict):
            return False, f"读 agent 失败 HTTP {st}"
        cfg = dict(agent.get("adapterConfig") or {})
        cfg["promptTemplate"] = content
        st2, d2 = call("PATCH", f"/api/agents/{agent_id}", {"adapterConfig": cfg})
        if st2 in (200, 201):
            return True, None
        return False, f"写 promptTemplate 失败 HTTP {st2}: {json.dumps(d2, ensure_ascii=False)[:180]}"
    return False, "当前 instructions 不可写"


def apply_member_patch(company, agent_id, fields):
    """共享写内核：白名单 merge，禁 replaceAdapterConfig；跨团队由调用方或此处 404。

    fields 已通过 validate_member_fields 的 cleaned 字典，或不含非法键。
    返回 dict，含 ok / applied / error / field / httpStatus。
    """
    company = company or COMPANY
    if not any(a.get("id") == agent_id for a in agents_for(company)):
        return {"ok": False, "error": "agent not found for this team", "httpStatus": 404}

    cleaned, err = validate_member_fields(fields)
    if err:
        err["httpStatus"] = 400
        return err

    want_instructions = "instructions" in cleaned
    patch_fields = {k: v for k, v in cleaned.items() if k != "instructions"}

    st, agent = call("GET", f"/api/agents/{agent_id}")
    if st != 200 or not isinstance(agent, dict):
        return {"ok": False, "error": f"读 agent 失败 HTTP {st}",
                "httpStatus": 502 if st >= 500 or st == 599 else st}

    applied = []
    patch_body = {}

    if "name" in patch_fields:
        patch_body["name"] = patch_fields["name"]
    if "title" in patch_fields:
        patch_body["title"] = patch_fields["title"]

    need_adapter = any(k in patch_fields for k in ("model", "timeoutSec"))
    if need_adapter:
        cfg = dict(agent.get("adapterConfig") or {})
        if "model" in patch_fields:
            cfg["model"] = patch_fields["model"]
        if "timeoutSec" in patch_fields:
            cfg["timeoutSec"] = patch_fields["timeoutSec"]
        patch_body["adapterConfig"] = cfg

    if "maxConcurrentRuns" in patch_fields:
        rc = dict(agent.get("runtimeConfig") or {})
        heartbeat = dict(rc.get("heartbeat") or {})
        heartbeat["maxConcurrentRuns"] = patch_fields["maxConcurrentRuns"]
        rc["heartbeat"] = heartbeat
        patch_body["runtimeConfig"] = rc

    if patch_body:
        st2, d2 = call("PATCH", f"/api/agents/{agent_id}", patch_body)
        if st2 not in (200, 201):
            return {
                "ok": False,
                "error": f"HTTP {st2}: {json.dumps(d2, ensure_ascii=False)[:200]}",
                "httpStatus": 502 if st2 >= 500 or st2 == 599 else st2,
                "applied": [],
            }
        for key in ("name", "title", "model", "timeoutSec", "maxConcurrentRuns"):
            if key in patch_fields:
                applied.append(key)
        # 刷新本地 agent 视图（后续 runtime/identity）
        if isinstance(d2, dict):
            agent = d2

    instructions_error = None
    if want_instructions:
        probe = probe_instructions(agent_id, agent)
        if probe.get("mode") != "writable":
            instructions_error = {
                "ok": False,
                "error": "当前 instructions 不可写",
                "field": "instructions",
                "httpStatus": 409,
                "applied": list(applied),
            }
        else:
            ok_write, write_err = _write_instructions(agent_id, cleaned["instructions"], probe)
            if ok_write:
                applied.append("instructions")
            else:
                instructions_error = {
                    "ok": False,
                    "error": write_err or "写 instructions 失败",
                    "field": "instructions",
                    "httpStatus": 502,
                    "applied": list(applied),
                }

    if applied:
        invalidate_member_caches(company)

    runtime = _runtime_from_agent(agent)
    runtime.pop("_rawMaxConcurrentRuns", None)
    # 若刚写入但响应未带回新值，用 cleaned 覆盖展示
    if "model" in cleaned:
        runtime["model"] = cleaned["model"]
    if "timeoutSec" in cleaned:
        runtime["timeoutSec"] = cleaned["timeoutSec"]
    if "maxConcurrentRuns" in cleaned:
        runtime["maxConcurrentRuns"] = cleaned["maxConcurrentRuns"]
        runtime["warning"] = None

    identity = {
        "name": cleaned.get("name", agent.get("name")),
        "title": cleaned["title"] if "title" in cleaned else (agent.get("title") if agent.get("title") is not None else ""),
    }

    if instructions_error:
        instructions_error["runtime"] = runtime
        instructions_error["identity"] = identity
        return instructions_error

    result = {"ok": True, "applied": applied, "runtime": runtime, "identity": identity}
    if "model" in cleaned and len(cleaned) == 1:
        # 兼容旧 /api/model 调用方：额外带 model 字段
        result["model"] = cleaned["model"]
    return result


def set_model(agent_id, model, company=None):
    """保留 Composer 快捷改模型；内部走共享 apply_member_patch。"""
    company = company or COMPANY
    result = apply_member_patch(company, agent_id, {"model": model})
    if result.get("ok"):
        return {"ok": True, "model": model}
    return {"ok": False, "error": result.get("error") or "改模型失败"}


# ---------------------------------------------------------------- 巡检

OPS_STALE_MINUTES = 30
OPS_RECENT_HOURS = 24
OPS_ISSUE_LIMIT = 5000
OPS_RUN_LIMIT = 2000


def _epoch(value):
    """ISO 时间转 epoch；脏数据返回 None，不让整页巡检失败。"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def fetch_all_issues(company):
    st, data = call("GET", f"/api/companies/{company}/issues?limit={OPS_ISSUE_LIMIT}")
    return as_list(data, "issues") if st == 200 else []


def fetch_issue_interactions(issue_id):
    st, data = call("GET", f"/api/issues/{issue_id}/interactions")
    return as_list(data, "interactions") if st == 200 else []


def fetch_all_runs(company):
    st, data = call("GET", f"/api/companies/{company}/heartbeat-runs?limit={OPS_RUN_LIMIT}")
    return as_list(data, "runs") if st == 200 else []


def _owner_label(owner, names):
    if owner == "board":
        return "用户"
    if isinstance(owner, dict):
        if owner.get("agentId"):
            return names.get(owner["agentId"]) or owner["agentId"][:8]
        if owner.get("userId"):
            return "用户"
    return "未登记"


def ops_payload(company):
    """运维巡检：状态真实性、阻塞时长、近期失败率。只读聚合，不改任何状态。"""
    issues = cached("ops:issues:" + company, 20.0, lambda: fetch_all_issues(company))
    runs = cached("ops:runs:" + company, 20.0, lambda: fetch_all_runs(company))
    names = {a.get("id"): a.get("name") for a in agents_for(company)}
    now = time.time()

    status_counts = {}
    for issue in issues:
        key = issue.get("status") or "unknown"
        status_counts[key] = status_counts.get(key, 0) + 1

    active = set()
    runs_by_issue = {}
    for run in runs:
        issue_id = (run.get("contextSnapshot") or {}).get("issueId")
        if not issue_id:
            continue
        runs_by_issue[issue_id] = runs_by_issue.get(issue_id, 0) + 1
        if run.get("status") in ("running", "queued"):
            active.add(issue_id)

    # 状态真实性：in_progress 但没有任何活着的 run，且超出静默阈值或本来就没指派。
    stale = []
    for issue in issues:
        if issue.get("status") != "in_progress" or issue.get("id") in active:
            continue
        last = _epoch(issue.get("lastActivityAt")) or _epoch(issue.get("updatedAt"))
        idle = (now - last) / 60 if last else None
        if issue.get("assigneeAgentId") and idle is not None and idle < OPS_STALE_MINUTES:
            continue
        stale.append({
            "id": issue.get("id"),
            "identifier": issue.get("identifier"),
            "title": issue.get("title"),
            "owner": names.get(issue.get("assigneeAgentId")) or "未指派",
            "idleMinutes": round(idle, 1) if idle is not None else None,
            "runs": runs_by_issue.get(issue.get("id"), 0),
        })
    stale.sort(key=lambda item: -(item["idleMinutes"] or 0))

    # 区分“等用户回答”和“真的没人管”：有 pending 交互的不算陈旧，交互过期的单独标注。
    awaiting = []
    for item in list(stale)[:12]:
        interactions = cached("ops:interactions:" + item["id"], 20.0,
                              lambda iid=item["id"]: fetch_issue_interactions(iid))
        latest = None
        for it in interactions:
            if it.get("status") in ("pending", "expired"):
                if latest is None or (it.get("createdAt") or "") > (latest.get("createdAt") or ""):
                    latest = it
        if not latest:
            continue
        prompt = ""
        questions = (latest.get("payload") or {}).get("questions") or []
        if questions and isinstance(questions[0], dict):
            prompt = questions[0].get("prompt") or ""
        if latest.get("status") == "pending":
            stale.remove(item)
            awaiting.append({
                "identifier": item["identifier"],
                "title": item["title"],
                "owner": item["owner"],
                "prompt": prompt[:160],
                "idleMinutes": item["idleMinutes"],
            })
        else:
            item["interaction"] = "expired"
    for item in stale:
        item.pop("id", None)
    stale.sort(key=lambda item: -(item["idleMinutes"] or 0))
    awaiting.sort(key=lambda item: -(item["idleMinutes"] or 0))

    blocked = []
    for issue in issues:
        if issue.get("status") != "blocked":
            continue
        since = _epoch(issue.get("blockedTransitionAt")) or _epoch(issue.get("updatedAt"))
        descriptor = issue.get("unblockDescriptor") or {}
        attention = issue.get("blockerAttention") or {}
        owner = descriptor.get("owner")
        last = _epoch(issue.get("lastActivityAt"))
        blocked.append({
            "identifier": issue.get("identifier"),
            "title": issue.get("title"),
            "owner": names.get(issue.get("assigneeAgentId")) or "未指派",
            "waitingOn": _owner_label(owner, names),
            "action": descriptor.get("action"),
            "ageHours": round((now - since) / 3600, 1) if since else None,
            "silentHours": round((now - last) / 3600, 1) if last else None,
            "attention": attention.get("state"),
            "reason": attention.get("reason"),
            "onBoard": owner == "board" or (isinstance(owner, dict) and bool(owner.get("userId"))),
        })
    blocked.sort(key=lambda item: -(item["ageHours"] or 0))

    run_counts = {}
    for run in runs:
        key = run.get("status") or "unknown"
        run_counts[key] = run_counts.get(key, 0) + 1
    recent_failed = recent_timeout = 0
    for run in runs:
        created = _epoch(run.get("createdAt"))
        if not created or now - created > OPS_RECENT_HOURS * 3600:
            continue
        if run.get("status") == "failed":
            recent_failed += 1
        elif run.get("status") == "timed_out":
            recent_timeout += 1

    # 配置预检：启动即失败的坑（命令路径、模型、超时档位、成员状态）在巡检里提前暴露。
    preflight = []
    for agent in agents_for(company):
        if agent.get("status") == "paused":
            continue  # 刻意暂停的成员不参与预检，避免长期噪声
        cfg = agent.get("adapterConfig") or {}
        label = agent.get("name") or agent.get("id", "")[:8]
        if cfg.get("hermesCommand") and not os.path.exists(cfg["hermesCommand"]):
            preflight.append({"agent": label, "code": "command_missing",
                              "detail": f"hermesCommand 不存在：{cfg['hermesCommand']}"})
        if not cfg.get("model"):
            preflight.append({"agent": label, "code": "model_missing", "detail": "未配置模型"})
        if cfg.get("timeoutSec") and cfg["timeoutSec"] < 1200:
            preflight.append({"agent": label, "code": "timeout_low",
                              "detail": f"timeoutSec={cfg['timeoutSec']}s，低于建议下限 1200s"})
        if agent.get("status") == "error":
            preflight.append({"agent": label, "code": "agent_error",
                              "detail": agent.get("errorReason") or "成员处于 error 状态"})

    on_board = [item for item in blocked if item["onBoard"]]
    longest = max((item.get("silentHours") or 0 for item in on_board), default=0)
    alerts = []
    if on_board:
        alerts.append({"level": "warn", "code": "board_gate",
                       "message": f"{len(on_board)} 个任务在等你授权或拍板，最长静默 {longest:.1f}h"})
    if awaiting:
        alerts.append({"level": "warn", "code": "awaiting_answer",
                       "message": f"{len(awaiting)} 个任务在等你回答问题"})
    if stale:
        alerts.append({"level": "warn", "code": "stale_status",
                       "message": f"{len(stale)} 个 in_progress 任务没有活跃运行"})
    if recent_timeout > 2:
        alerts.append({"level": "warn", "code": "timeouts",
                       "message": f"近 {OPS_RECENT_HOURS}h 超时 {recent_timeout} 次"})
    if recent_failed:
        alerts.append({"level": "warn", "code": "failures",
                       "message": f"近 {OPS_RECENT_HOURS}h 适配器失败 {recent_failed} 次"})
    if preflight:
        alerts.append({"level": "warn", "code": "preflight",
                       "message": f"{len(preflight)} 个成员配置有问题（路径/模型/超时/状态）"})

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tasks": {"total": len(issues), "byStatus": status_counts, "stale": stale[:20],
                  "awaiting": awaiting[:20]},
        "blocked": {
            "count": len(blocked),
            "over24h": sum(1 for item in blocked if (item["ageHours"] or 0) > 24),
            "onBoard": len(on_board),
            "items": blocked[:20],
        },
        "runs": {
            "total": len(runs),
            "byStatus": run_counts,
            "recent": {"hours": OPS_RECENT_HOURS, "failed": recent_failed, "timedOut": recent_timeout},
        },
        "preflight": preflight[:20],
        "alerts": alerts,
    }
