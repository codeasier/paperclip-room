"""运维巡检聚合：固定样本，不访问 Paperclip 实例。"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


AGENTS = [
    {"id": "pl", "name": "PL", "status": "idle"},
    {"id": "backend", "name": "Backend", "status": "idle"},
]
HEALTHY_AGENTS = [
    {"id": "pl", "name": "PL", "status": "idle", "adapterType": "hermes_local",
     "adapterConfig": {"model": "m", "timeoutSec": 2700, "hermesCommand": "/bin/sh"}},
    {"id": "backend", "name": "Backend", "status": "idle", "adapterType": "hermes_local",
     "adapterConfig": {"model": "m", "timeoutSec": 3600, "hermesCommand": "/bin/sh"}},
]

NOW = datetime.now(timezone.utc)


def iso(minutes_ago=0):
    return (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def issue(iid, ident, status, assignee="pl", idle_minutes=90, **extra):
    data = {
        "id": iid, "identifier": ident, "title": f"{ident} 任务",
        "status": status, "assigneeAgentId": assignee,
        "createdAt": iso(2000), "updatedAt": iso(idle_minutes),
        "lastActivityAt": iso(idle_minutes),
    }
    data.update(extra)
    return data


def run(rid, issue_id, status, minutes_ago=5):
    return {
        "id": rid, "status": status, "createdAt": iso(minutes_ago),
        "contextSnapshot": {"issueId": issue_id},
    }


class OpsPayloadTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    def load(self, issues, runs=None, interactions=None, agents=None):
        interactions = interactions or {}
        with patch.object(server, "fetch_agents", return_value=agents or HEALTHY_AGENTS), \
             patch.object(server, "fetch_all_issues", return_value=issues), \
             patch.object(server, "fetch_all_runs", return_value=runs or []), \
             patch.object(server, "fetch_issue_interactions",
                          side_effect=lambda iid: interactions.get(iid, [])):
            return server.ops_payload("company")

    def test_stale_in_progress_without_active_run(self):
        payload = self.load([
            issue("a", "HER-1", "in_progress", "backend"),
            issue("b", "HER-2", "in_progress", "backend"),
        ], [run("r1", "b", "running")])
        stale = {item["identifier"] for item in payload["tasks"]["stale"]}
        self.assertEqual(stale, {"HER-1"})
        self.assertEqual(payload["tasks"]["byStatus"]["in_progress"], 2)

    def test_stale_ignores_fresh_activity(self):
        payload = self.load([issue("a", "HER-1", "in_progress", "backend", idle_minutes=5)])
        self.assertEqual(payload["tasks"]["stale"], [])

    def test_unassigned_in_progress_is_stale_even_when_fresh(self):
        payload = self.load([issue("a", "HER-1", "in_progress", None, idle_minutes=1)])
        self.assertEqual(len(payload["tasks"]["stale"]), 1)
        self.assertEqual(payload["tasks"]["stale"][0]["owner"], "未指派")

    def test_blocked_aging_and_board_gate(self):
        payload = self.load([
            issue("a", "HER-1", "blocked", "pl", idle_minutes=60 * 50,
                  blockedTransitionAt=iso(60 * 50),
                  unblockDescriptor={"owner": "board", "action": "授权合入 PR #1"}),
            issue("b", "HER-2", "blocked", "backend", idle_minutes=60 * 2,
                  blockedTransitionAt=iso(60 * 2),
                  unblockDescriptor={"owner": {"agentId": "backend"}, "action": "等依赖"}),
        ])
        self.assertEqual(payload["blocked"]["count"], 2)
        self.assertEqual(payload["blocked"]["over24h"], 1)
        self.assertEqual(payload["blocked"]["onBoard"], 1)
        self.assertEqual(payload["blocked"]["items"][0]["identifier"], "HER-1")
        self.assertEqual(payload["blocked"]["items"][0]["waitingOn"], "用户")
        self.assertGreater(payload["blocked"]["items"][0]["silentHours"], 40)
        codes = {alert["code"] for alert in payload["alerts"]}
        self.assertIn("board_gate", codes)

    def test_pending_interaction_is_awaiting_not_stale(self):
        payload = self.load(
            [issue("a", "HER-1", "in_progress", "backend", idle_minutes=120)],
            interactions={"a": [{
                "status": "pending", "kind": "ask_user_questions",
                "createdAt": iso(100),
                "payload": {"questions": [{"prompt": "选哪种闭环方式？"}]},
            }]},
        )
        self.assertEqual(payload["tasks"]["stale"], [])
        self.assertEqual(len(payload["tasks"]["awaiting"]), 1)
        self.assertEqual(payload["tasks"]["awaiting"][0]["identifier"], "HER-1")
        self.assertIn("awaiting_answer", {a["code"] for a in payload["alerts"]})

    def test_expired_interaction_stays_stale(self):
        payload = self.load(
            [issue("a", "HER-1", "in_progress", "backend", idle_minutes=120)],
            interactions={"a": [{"status": "expired", "kind": "ask_user_questions",
                                 "createdAt": iso(100), "payload": {}}]},
        )
        self.assertEqual(len(payload["tasks"]["stale"]), 1)
        self.assertEqual(payload["tasks"]["stale"][0]["interaction"], "expired")
        self.assertEqual(payload["tasks"]["awaiting"], [])

    def test_preflight_flags_bad_configuration(self):
        agents = [
            {"id": "backend", "name": "Backend", "status": "error", "errorReason": "Timed out",
             "adapterType": "hermes_local",
             "adapterConfig": {"model": None, "timeoutSec": 300, "hermesCommand": "/nope/hermes"}},
        ]
        payload = self.load([issue("a", "HER-1", "todo")], agents=agents)
        codes = {item["code"] for item in payload["preflight"]}
        self.assertEqual(codes, {"command_missing", "model_missing", "timeout_low", "agent_error"})
        self.assertIn("preflight", {alert["code"] for alert in payload["alerts"]})

    def test_healthy_config_has_no_preflight(self):
        payload = self.load([issue("a", "HER-1", "todo")])
        self.assertEqual(payload["preflight"], [])
        self.assertNotIn("preflight", {alert["code"] for alert in payload["alerts"]})

    def test_recent_failures_and_timeouts(self):
        runs = [run(f"r{i}", "a", "timed_out", minutes_ago=10) for i in range(3)]
        runs.append(run("r9", "a", "failed", minutes_ago=3000))
        payload = self.load([issue("a", "HER-1", "todo")], runs)
        self.assertEqual(payload["runs"]["byStatus"]["timed_out"], 3)
        self.assertEqual(payload["runs"]["recent"]["timedOut"], 3)
        self.assertEqual(payload["runs"]["recent"]["failed"], 0)
        codes = {alert["code"] for alert in payload["alerts"]}
        self.assertIn("timeouts", codes)


if __name__ == "__main__":
    unittest.main()
