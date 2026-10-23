#!/usr/bin/env python3
"""定时巡检：把控制台 /api/ops 的结论落成时序日志。

设计：只读控制台接口，不碰 Paperclip。告警写到 journal（带 [slo][warn] 前缀），
只有「读不到控制台」才以非零退出，避免告警把 systemd 单元长期标成 failed。

用法：
    python3 ops/slo.py            # 读 ROOM_URL 默认 http://127.0.0.1:3200
    SLO_LOG=/path/slo.jsonl python3 ops/slo.py
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOM_URL = os.environ.get("ROOM_URL", "http://127.0.0.1:3200").rstrip("/")
COMPANY = os.environ.get("PAPERCLIP_COMPANY", "").strip()
SLO_LOG = Path(os.environ.get("SLO_LOG", Path.home() / "paperclip-room" / "logs" / "slo.jsonl")).expanduser()


def fetch_ops(timeout=20):
    url = f"{ROOM_URL}/api/ops"
    if COMPANY:
        url += "?company=" + COMPANY
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def summarize(payload):
    """把巡检结果压成一行可入库的指标；缺字段按 0 处理，不因上游改版整体失败。"""
    tasks = payload.get("tasks") or {}
    blocked = payload.get("blocked") or {}
    runs = payload.get("runs") or {}
    recent = runs.get("recent") or {}
    alerts = payload.get("alerts") or []
    preflight = payload.get("preflight") or []
    return {
        "at": int(time.time()),
        "tasks": tasks.get("total", 0),
        "blocked": blocked.get("count", 0),
        "blockedOnBoard": blocked.get("onBoard", 0),
        "blockedOver24h": blocked.get("over24h", 0),
        "stale": len(tasks.get("stale") or []),
        "awaiting": len(tasks.get("awaiting") or []),
        "runs": runs.get("total", 0),
        "failed24h": recent.get("failed", 0),
        "timedOut24h": recent.get("timedOut", 0),
        "preflight": len(preflight),
        "alerts": [item.get("code") for item in alerts],
    }


def main():
    try:
        payload = fetch_ops()
    except Exception as exc:  # 控制台没起或网络抖动：记一条并失败退出
        print(f"[slo] 读取失败: {exc}")
        return 2
    row = summarize(payload)
    SLO_LOG.parent.mkdir(parents=True, exist_ok=True)
    with SLO_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    alerts = payload.get("alerts") or []
    preflight = payload.get("preflight") or []
    print(f"[slo] 任务 {row['tasks']} · 阻塞 {row['blocked']}（等你 {row['blockedOnBoard']}）"
          f" · 陈旧 {row['stale']} · 待回答 {row['awaiting']}"
          f" · 近24h 超时 {row['timedOut24h']} / 失败 {row['failed24h']}"
          f" · 配置问题 {row['preflight']}")
    for item in alerts:
        print(f"[slo][{item.get('level', 'warn')}] {item.get('code')}: {item.get('message')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
