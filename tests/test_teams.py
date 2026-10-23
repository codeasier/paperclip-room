"""多团队选择：公司解析、团队列表和按团队隔离的缓存。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


COMPANIES = [
    {"id": "c1", "name": "Beta", "status": "active", "issuePrefix": "B"},
    {"id": "c2", "name": "Alpha", "status": "active", "issuePrefix": "A"},
    {"id": "c3", "name": "Archived", "status": "archived", "issuePrefix": "X"},
]


class TeamTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    def test_teams_payload_puts_default_first_and_skips_archived(self):
        with patch.object(server, "COMPANY", "c2"), \
             patch.object(server, "company_list", return_value=COMPANIES):
            data = server.teams_payload()
        self.assertEqual([team["id"] for team in data["teams"]], ["c2", "c1"])
        self.assertEqual(data["default"], "c2")
        self.assertTrue(data["teams"][0]["isDefault"])
        self.assertFalse(data["teams"][1]["isDefault"])

    def test_teams_payload_falls_back_to_env_company(self):
        with patch.object(server, "COMPANY", "c9"), \
             patch.object(server, "company_list", return_value=[]):
            data = server.teams_payload()
        self.assertEqual(data["default"], "c9")
        self.assertEqual([team["id"] for team in data["teams"]], ["c9"])
        self.assertEqual(data["teams"][0]["name"], "当前团队")

    def test_resolve_company_accepts_visible_and_default_only(self):
        with patch.object(server, "COMPANY", "default"), \
             patch.object(server, "company_list", return_value=COMPANIES):
            self.assertEqual(server.resolve_company(""), "default")
            self.assertEqual(server.resolve_company("default"), "default")
            self.assertEqual(server.resolve_company("c1"), "c1")
            self.assertIsNone(server.resolve_company("missing"))
            self.assertIsNone(server.resolve_company("c3"))

    def test_issue_cache_is_isolated_per_company(self):
        calls = []

        def fake_call(method, path, body=None):
            calls.append(path)
            if "/companies/c1/issues" in path:
                return 200, [{"id": "issue-c1"}]
            if "/companies/c2/issues" in path:
                return 200, [{"id": "issue-c2"}]
            return 200, {}

        with patch.object(server, "call", side_effect=fake_call):
            first = server.fetch_issues("c1")
            second = server.fetch_issues("c2")
            again = server.fetch_issues("c1")
        self.assertEqual([item["id"] for item in first], ["issue-c1"])
        self.assertEqual([item["id"] for item in second], ["issue-c2"])
        self.assertEqual(again, first)
        self.assertEqual(len(calls), 2)

    def test_snapshot_requests_selected_company(self):
        with patch.object(server, "fetch_agents", return_value=[]) as agents, \
             patch.object(server, "fetch_issues", return_value=[]) as issues, \
             patch.object(server, "fetch_runs", return_value=[]) as runs:
            data = server.agent_snapshot("c2")
        agents.assert_called_once_with("c2")
        issues.assert_called_once_with("c2")
        runs.assert_called_once_with("c2")
        self.assertEqual(data["companyId"], "c2")
        self.assertEqual(data["agents"], [])

    def test_room_timeline_uses_selected_company(self):
        with patch.object(server, "fetch_agents", return_value=[]) as agents, \
             patch.object(server, "fetch_issues", return_value=[]) as issues, \
             patch.object(server, "fetch_receipt_runs", return_value={
                 "available": True, "runs": [], "limit": 200}) as receipts:
            data = server.room_timeline("agent-1", company="c2")
        agents.assert_called_once_with("c2")
        issues.assert_called_once_with("c2")
        receipts.assert_called_once_with("c2")
        self.assertEqual(data["agentId"], "agent-1")

    def test_send_message_posts_to_selected_company(self):
        with patch.object(server, "fetch_issues", return_value=[]), \
             patch.object(server, "call", return_value=(201, {"identifier": "COD-1"})) as api:
            result = server.send_message("agent-1", "新需求", "c2")
        self.assertTrue(result["ok"])
        self.assertEqual(api.call_args.args[1], "/api/companies/c2/issues")

    def test_task_aggregation_scopes_runs_to_company(self):
        runs = [
            {"id": "r1", "companyId": "c2", "status": "succeeded",
             "createdAt": "2026-10-22T08:00:00Z", "contextSnapshot": {"issueId": "i1"}},
            {"id": "r2", "companyId": "c1", "status": "failed",
             "createdAt": "2026-10-22T08:01:00Z", "contextSnapshot": {"issueId": "i1"}},
        ]
        with patch.object(server, "fetch_runs", return_value=runs):
            index, fetched = server.task_run_index("c2")
        self.assertEqual(fetched, 2)
        self.assertEqual([run["id"] for run in index["i1"]], ["r1"])


if __name__ == "__main__":
    unittest.main()
