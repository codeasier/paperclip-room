"""活跃运行归属：任务运行、后台运行与排队必须能区分。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


AGENTS = [
    {"id": "pl", "name": "PL", "status": "running"},
    {"id": "be", "name": "Backend", "status": "running"},
    {"id": "qa", "name": "QA", "status": "idle"},
]

ISSUES = [
    {"id": "i1", "identifier": "HER-1", "title": "任务一", "status": "in_progress",
     "assigneeAgentId": "pl", "updatedAt": "2026-10-23T13:00:00Z"},
    {"id": "i2", "identifier": "HER-2", "title": "任务二", "status": "todo",
     "assigneeAgentId": "be", "updatedAt": "2026-10-23T12:00:00Z"},
]

RUNS = [
    {"id": "pl-task", "agentId": "pl", "companyId": server.COMPANY,
     "status": "running", "issueId": "i1", "scopeKind": "issue",
     "invocationSource": "assignment", "createdAt": "2026-10-23T13:00:00Z",
     "startedAt": "2026-10-23T13:00:01Z", "lastOutputAt": "2026-10-23T13:01:00Z"},
    {"id": "be-bg", "agentId": "be", "companyId": server.COMPANY,
     "status": "running", "scopeKind": "company",
     "invocationSource": "timer", "createdAt": "2026-10-23T13:02:00Z",
     "startedAt": "2026-10-23T13:02:01Z"},
    {"id": "be-chat", "agentId": "be", "companyId": server.COMPANY,
     "status": "queued", "issueId": "chat-hidden", "scopeKind": "issue",
     "invocationSource": "on_demand", "createdAt": "2026-10-23T13:03:00Z",
     "contextSnapshot": {"taskKey": "HER-99"}},
    {"id": "be-context", "agentId": "be", "companyId": server.COMPANY,
     "status": "running", "scopeKind": "issue",
     "invocationSource": "automation", "createdAt": "2026-10-23T12:59:00Z",
     "startedAt": "2026-10-23T12:59:01Z",
     "contextSnapshot": {"issueId": "i2", "commentId": "c1"}},
]


class LiveRunViewTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    def snapshot(self, runs=None, agents=None, issues=None):
        with patch.object(server, "fetch_agents", return_value=agents or AGENTS), \
             patch.object(server, "fetch_issues", return_value=issues or ISSUES), \
             patch.object(server, "fetch_runs", return_value=runs if runs is not None else RUNS):
            return server.agent_snapshot("c1")

    def agent(self, data, name):
        return next(item for item in data["agents"] if item["name"] == name)

    def test_company_totals_split_task_and_background_runs(self):
        data = self.snapshot()
        self.assertEqual(data["liveRuns"], 4)
        self.assertEqual(data["liveRunning"], 3)
        self.assertEqual(data["liveQueued"], 1)
        self.assertEqual(data["liveTaskRuns"], 2)
        self.assertEqual(data["liveBackgroundRuns"], 2)
        self.assertEqual(data["liveTaskRunning"], 2)
        self.assertEqual(data["liveBackgroundRunning"], 1)

    def test_task_run_keeps_identifier_and_counts_as_task(self):
        data = self.snapshot()
        pl = self.agent(data, "PL")
        self.assertEqual(pl["running"], 1)
        self.assertEqual(pl["live"]["taskRunning"], 1)
        self.assertEqual(pl["live"]["backgroundRunning"], 0)
        run = pl["live"]["runs"][0]
        self.assertEqual(run["id"], "pl-task")
        self.assertEqual(run["issue"], "HER-1")
        self.assertTrue(run["linked"])
        self.assertFalse(run["unlisted"])
        self.assertEqual(run["source"], "assignment")

    def test_background_and_unlisted_runs_are_not_tasks(self):
        data = self.snapshot()
        be = self.agent(data, "Backend")
        self.assertEqual(be["running"], 3)
        live = be["live"]
        self.assertEqual(live["running"], 2)
        self.assertEqual(live["queued"], 1)
        self.assertEqual(live["task"], 1)
        self.assertEqual(live["background"], 2)
        self.assertEqual(live["taskRunning"], 1)
        self.assertEqual(live["backgroundRunning"], 1)
        self.assertEqual(live["backgroundQueued"], 1)

        runs = {run["id"]: run for run in live["runs"]}
        self.assertEqual(runs["be-bg"]["source"], "timer")
        self.assertFalse(runs["be-bg"]["linked"])
        self.assertFalse(runs["be-bg"]["unlisted"])
        self.assertEqual(runs["be-context"]["issue"], "HER-2")
        self.assertTrue(runs["be-context"]["linked"])
        self.assertFalse(runs["be-chat"]["linked"])
        self.assertTrue(runs["be-chat"]["unlisted"])
        self.assertEqual(runs["be-chat"]["taskKey"], "HER-99")
        self.assertIsNone(runs["be-chat"]["issue"])

    def test_running_runs_sort_before_queued_runs(self):
        data = self.snapshot()
        statuses = [run["status"] for run in self.agent(data, "Backend")["live"]["runs"]]
        self.assertEqual(statuses, ["running", "running", "queued"])

    def test_task_running_agents_sort_before_background_runs(self):
        agents = [
            {"id": "pl", "name": "PL", "status": "running"},
            {"id": "ci", "name": "DevOps", "status": "running"},
        ]
        issues = [{"id": "i9", "identifier": "HER-9", "title": "任务九", "status": "in_progress",
                   "assigneeAgentId": "ci", "updatedAt": "2026-10-23T13:00:00Z"}]
        runs = [
            {"id": "bg", "agentId": "pl", "companyId": server.COMPANY, "status": "running",
             "scopeKind": "company", "invocationSource": "timer",
             "createdAt": "2026-10-23T13:00:00Z", "startedAt": "2026-10-23T13:00:01Z"},
            {"id": "task", "agentId": "ci", "companyId": server.COMPANY, "status": "running",
             "issueId": "i9", "scopeKind": "issue", "invocationSource": "assignment",
             "createdAt": "2026-10-23T12:58:00Z", "startedAt": "2026-10-23T12:58:01Z"},
        ]
        data = self.snapshot(runs=runs, agents=agents, issues=issues)
        self.assertEqual([item["name"] for item in data["agents"]], ["DevOps", "PL"])

    def test_agent_without_live_runs_reports_zeros(self):
        data = self.snapshot()
        qa = self.agent(data, "QA")
        self.assertEqual(qa["running"], 0)
        self.assertEqual(qa["live"]["runs"], [])
        self.assertEqual(qa["live"]["task"], 0)
        self.assertEqual(qa["live"]["background"], 0)

    def test_live_view_tolerates_missing_context(self):
        run = {"id": "r1", "status": "queued", "issueId": None}
        view = server.live_run_view(run, {})
        self.assertIsNone(view["issueId"])
        self.assertFalse(view["linked"])
        self.assertFalse(view["unlisted"])

    def test_no_runs_keeps_empty_snapshot(self):
        data = self.snapshot(runs=[])
        self.assertEqual(data["liveRuns"], 0)
        self.assertEqual(data["liveTaskRuns"], 0)
        for item in data["agents"]:
            self.assertEqual(item["live"]["runs"], [])


if __name__ == "__main__":
    unittest.main()
