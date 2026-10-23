"""任务进展聚合：固定样本，不访问 Paperclip 实例。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


AGENTS = [
    {"id": "pl", "name": "PL", "status": "idle"},
    {"id": "qa", "name": "QA", "status": "idle"},
    {"id": "backend", "name": "Backend", "status": "idle"},
]


def issue(iid, ident, status, assignee="pl", updated="2026-10-22T08:00:00Z", **extra):
    data = {
        "id": iid, "identifier": ident, "title": f"{ident} 任务",
        "status": status, "assigneeAgentId": assignee,
        "createdAt": "2026-10-22T07:00:00Z", "updatedAt": updated,
        "description": "", "descriptionTruncated": False,
    }
    data.update(extra)
    return data


class TaskProgressTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    def load(self, issues, comments=None, runs=None, agent="pl", member_runs=None, member_available=True):
        comments = comments or {}
        runs = runs or []
        with patch.object(server, "fetch_agents", return_value=AGENTS), \
             patch.object(server, "fetch_issues", return_value=issues), \
             patch.object(server, "fetch_runs", return_value=runs), \
             patch.object(server, "fetch_agent_runs", return_value={"available": member_available, "runs": member_runs or []}), \
             patch.object(server, "fetch_comments", side_effect=lambda iid: comments.get(iid, [])):
            return server.agent_tasks(agent)

    def test_checklist_parsing_ignores_code_fences(self):
        text = "## 范围\n- [x] 接口\n- [ ] 页面\n\n```text\n- [ ] 示例\n```\n- [X] 联调"
        checklist = server.checklist_progress(text)
        self.assertEqual(checklist["done"], 2)
        self.assertEqual(checklist["total"], 3)
        self.assertEqual([item["text"] for item in checklist["items"]], ["接口", "页面", "联调"])
        self.assertFalse(checklist["partial"])
        self.assertIsNone(server.checklist_progress("没有勾选项"))

    def test_truncated_description_is_flagged(self):
        checklist = server.checklist_progress("- [ ] 一", truncated=True)
        self.assertTrue(checklist["partial"])

    def test_open_tasks_and_recent_done_are_bounded(self):
        issues = [
            issue("i1", "HER-1", "todo"),
            issue("i2", "HER-2", "in_progress"),
            issue("i3", "HER-3", "blocked"),
            issue("i4", "HER-4", "backlog"),
            issue("i5", "HER-5", "done", updated="2026-10-22T07:50:00Z"),
            issue("i6", "HER-6", "done", updated="2026-10-22T07:40:00Z"),
            issue("i7", "HER-7", "done", updated="2026-10-22T07:30:00Z"),
            issue("i8", "HER-8", "done", updated="2026-10-22T07:20:00Z"),
            issue("i9", "HER-9", "done", updated="2026-10-22T07:10:00Z"),
            issue("i10", "HER-10", "cancelled", updated="2026-10-22T07:05:00Z"),
        ]
        data = self.load(issues)
        self.assertEqual([t["identifier"] for t in data["tasks"]],
                         ["HER-2", "HER-3", "HER-1", "HER-4",
                          "HER-5", "HER-6", "HER-7", "HER-8"])
        self.assertEqual(data["groups"]["open"], 4)
        self.assertEqual(data["groups"]["done"], 5)
        self.assertEqual(data["groups"]["doneShown"], 4)
        self.assertEqual(data["counts"]["open"], 4)
        self.assertEqual(data["tasks"][0]["phase"], 1)
        self.assertEqual(data["tasks"][1]["phase"], None)

    def test_runs_are_matched_by_issue_and_company(self):
        runs = [
            {"id": "r1", "status": "succeeded", "companyId": server.COMPANY,
             "createdAt": "2026-10-22T07:01:00Z", "finishedAt": "2026-10-22T07:02:00Z",
             "contextSnapshot": {"issueId": "i1"}},
            {"id": "r2", "status": "failed", "companyId": server.COMPANY,
             "createdAt": "2026-10-22T07:03:00Z", "finishedAt": "2026-10-22T07:04:00Z",
             "error": "Bearer abcdefghijklmnopqrstuv", "contextSnapshot": {"taskId": "i1"}},
            {"id": "r3", "status": "running", "companyId": server.COMPANY,
             "createdAt": "2026-10-22T07:05:00Z",
             "contextSnapshot": {"issueId": "i1"}},
            {"id": "r4", "status": "succeeded", "companyId": "other",
             "createdAt": "2026-10-22T07:06:00Z", "contextSnapshot": {"issueId": "i1"}},
            {"id": "r5", "status": "succeeded", "companyId": server.COMPANY,
             "createdAt": "2026-10-22T07:07:00Z", "contextSnapshot": {}},
        ]
        data = self.load([issue("i1", "HER-1", "in_progress")], runs=runs)
        stats = data["tasks"][0]["runs"]
        self.assertEqual(stats["total"], 3)
        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(stats["active"], 1)
        self.assertEqual(stats["lastStatus"], "running")
        self.assertEqual(stats["lastAt"], "2026-10-22T07:05:00Z")
        self.assertEqual(stats["lastError"], "")

    def test_failed_last_run_exposes_redacted_error(self):
        runs = [{"id": "r1", "status": "failed", "companyId": server.COMPANY,
                 "createdAt": "2026-10-22T07:01:00Z", "finishedAt": "2026-10-22T07:02:00Z",
                 "error": "Authorization: Bearer abcdefghijklmnopqrstuv",
                 "contextSnapshot": {"issueId": "i1"}}]
        data = self.load([issue("i1", "HER-1", "blocked")], runs=runs)
        self.assertNotIn("abcdefghijklmnopqrstuv", data["tasks"][0]["runs"]["lastError"])
        self.assertIn("已隐藏凭据", data["tasks"][0]["runs"]["lastError"])

    def test_timeline_preserves_parallel_members_and_unknown_times(self):
        runs = [
            {"id": "r1", "agentId": "pl", "status": "succeeded",
             "companyId": server.COMPANY, "contextSnapshot": {"issueId": "i1"},
             "startedAt": "2026-10-22T07:00:00Z", "finishedAt": "2026-10-22T07:05:00Z",
             "resultJson": {"private": "not exposed"}},
            {"id": "r2", "agentId": "qa", "status": "running",
             "companyId": server.COMPANY, "contextSnapshot": {"taskId": "i1"},
             "startedAt": "2026-10-22T07:02:00Z"},
            {"id": "r3", "agentId": "qa", "status": "queued",
             "companyId": server.COMPANY, "contextSnapshot": {"issueId": "i1"},
             "createdAt": "2026-10-22T07:03:00Z"},
            {"id": "foreign", "agentId": "pl", "companyId": "other",
             "contextSnapshot": {"issueId": "i1"}},
            {"id": "unrelated", "agentId": "pl", "companyId": server.COMPANY,
             "contextSnapshot": {"issueId": "i2"}},
        ]
        data = self.load([issue("i1", "HER-1", "in_progress")], runs=runs)
        attempts = data["tasks"][0]["attempts"]
        self.assertEqual([r["id"] for r in attempts], ["r1", "r2", "r3"])
        self.assertEqual([r["agentName"] for r in attempts], ["PL", "QA", "QA"])
        self.assertEqual(attempts[0]["startedAt"], runs[0]["startedAt"])
        self.assertIsNone(attempts[1]["finishedAt"])
        self.assertIsNone(attempts[2]["startedAt"])
        self.assertNotIn("resultJson", attempts[0])

    def test_comments_exclude_deleted_and_deduplicate_authors(self):
        comments = {
            "i1": [
                {"id": "c1", "createdAt": "2026-10-22T07:01:00Z", "body": "开始处理", "authorAgentId": "pl"},
                {"id": "c2", "createdAt": "2026-10-22T07:02:00Z", "body": "已确认", "authorAgentId": "qa"},
                {"id": "c3", "createdAt": "2026-10-22T07:03:00Z", "body": "已删除", "authorAgentId": "backend", "deletedAt": "2026-10-22T07:04:00Z"},
                {"id": "c4", "createdAt": "2026-10-22T07:05:00Z", "body": "补充", "authorUserId": "board"},
                {"id": "c5", "createdAt": "2026-10-22T07:06:00Z", "body": "收口", "derivedAuthorAgentId": "backend"},
            ],
        }
        data = self.load([issue("i1", "HER-1", "in_progress")], comments=comments)
        task = data["tasks"][0]
        self.assertEqual(task["comments"]["total"], 4)
        self.assertEqual([c["author"] for c in task["comments"]["latest"]],
                         ["QA", "用户", "Backend"])
        self.assertEqual(task["comments"]["latest"][-1]["text"], "收口")

    def test_participation_authored_and_addressed(self):
        issues = [
            issue("i1", "HER-1", "in_progress"),
            issue("i2", "HER-2", "in_progress", assignee="qa", updated="2026-10-22T08:10:00Z"),
            issue("i3", "HER-3", "todo", assignee="qa", updated="2026-10-22T08:09:00Z"),
            issue("i4", "HER-4", "todo", assignee="qa", updated="2026-10-22T08:08:00Z"),
        ]
        comments = {
            "i2": [{"id": "c1", "authorAgentId": "pl", "body": "只看这里", "createdAt": "2026-10-22T08:01:00Z"}],
            "i3": [{"id": "c2", "authorAgentId": "qa", "body": "给 @PL\n请确认", "createdAt": "2026-10-22T08:02:00Z"}],
            "i4": [{"id": "c3", "authorAgentId": "qa", "body": "普通讨论，正文提到 @PL", "createdAt": "2026-10-22T08:03:00Z"}],
        }
        data = self.load(issues, comments=comments)
        related = {task["identifier"]: task["relation"] for task in data["tasks"]}
        self.assertEqual(related, {
            "HER-1": "assigned",
            "HER-2": "authored",
            "HER-3": "addressed",
        })
        self.assertEqual(data["groups"]["participated"], 2)

    def test_parent_and_children_progress(self):
        issues = [
            issue("i1", "HER-1", "in_progress"),
            issue("i2", "HER-2", "done", parentId="i1", updated="2026-10-22T07:30:00Z"),
            issue("i3", "HER-3", "todo", parentId="i1"),
        ]
        data = self.load(issues)
        task = data["tasks"][0]
        self.assertEqual(task["children"], {"total": 2, "done": 1})
        child = next(t for t in data["tasks"] if t["identifier"] == "HER-2")
        self.assertEqual(child["parent"]["identifier"], "HER-1")

    def test_reassigned_tasks_outside_comment_window_remain_related_by_execution(self):
        issues = [issue(f"new-{i}", f"HER-{i}", "todo", assignee="qa") for i in range(12)]
        issues.extend([
            issue("old", "HER-OLD", "blocked", assignee="qa", updated="2026-10-20T08:00:00Z"),
            issue("cancelled", "HER-CANCELLED", "cancelled", assignee="qa", updated="2026-10-20T07:00:00Z"),
        ])
        own = [{"id": "old-run", "agentId": "pl", "companyId": server.COMPANY,
                "status": "failed", "startedAt": "2026-10-20T06:00:00Z",
                "finishedAt": "2026-10-20T06:01:00Z", "contextSnapshot": {"issueId": "old"}},
               {"id": "cancelled-run", "agentId": "pl", "companyId": server.COMPANY,
                "status": "cancelled", "createdAt": "2026-10-20T07:00:00Z",
                "contextSnapshot": {"taskId": "cancelled"}}]
        # The team window contains only other members' newer runs.
        team = [{"id": "new-run", "agentId": "qa", "companyId": server.COMPANY,
                 "contextSnapshot": {"issueId": "new-0"}}]
        data = self.load(issues, runs=team, member_runs=own)
        self.assertEqual({t["identifier"]: t["relation"] for t in data["tasks"]},
                         {"HER-OLD": "executed", "HER-CANCELLED": "executed"})
        self.assertEqual(data["groups"]["assigned"], 0)
        self.assertEqual(data["groups"]["executed"], 2)
        self.assertEqual(data["scope"]["memberRunsFetched"], 2)
        self.assertEqual(data["tasks"][0]["attempts"][0]["startedAt"], own[0]["startedAt"])

    def test_run_windows_deduplicate_and_preserve_existing_relation(self):
        run = {"id": "same", "agentId": "pl", "companyId": server.COMPANY,
               "status": "running", "contextSnapshot": {"issueId": "i1"}}
        data = self.load([issue("i1", "HER-1", "in_progress")], runs=[run],
                         member_runs=[{**run, "status": "succeeded"}])
        self.assertEqual(len(data["tasks"]), 1)
        task = data["tasks"][0]
        self.assertEqual(task["relation"], "assigned")
        self.assertEqual(task["runs"]["total"], 1)
        self.assertEqual(task["attempts"][0]["status"], "succeeded")
        self.assertEqual(data["groups"]["executed"], 0)

    def test_execution_relation_excludes_other_members_companies_and_hidden_chats(self):
        runs = [
            {"id": "other", "agentId": "qa", "companyId": server.COMPANY,
             "contextSnapshot": {"issueId": "i1"}},
            {"id": "foreign", "agentId": "pl", "companyId": "foreign-company",
             "contextSnapshot": {"issueId": "i1"}},
            {"id": "chat", "agentId": "pl", "companyId": server.COMPANY,
             "contextSnapshot": {"issueId": "hidden-chat"}},
        ]
        data = self.load([issue("i1", "HER-1", "todo", assignee="qa")], runs=runs)
        self.assertEqual(data["tasks"], [])

    def test_member_run_failure_keeps_known_tasks_and_reports_partial_scope(self):
        data = self.load([issue("i1", "HER-1", "todo")], member_available=False)
        self.assertEqual(data["state"], "available")
        self.assertEqual(len(data["tasks"]), 1)
        self.assertFalse(data["scope"]["memberRunsAvailable"])
        self.assertIn("补查暂不可用", data["note"])

    def test_unknown_agent_is_explicit(self):
        data = self.load([], agent="missing")
        self.assertEqual(data["state"], "unavailable")
        self.assertEqual(data["tasks"], [])

    def test_scope_and_note_are_explicit(self):
        data = self.load([issue("i1", "HER-1", "todo")])
        self.assertEqual(data["scope"]["runLimit"], 200)
        self.assertEqual(data["scope"]["participationWindow"], 12)
        self.assertIn("最近 4 项", data["note"])

    def test_create_task_posts_to_company_and_clears_caches(self):
        server._CACHE["issues:c1"] = (0, [])
        saved = {"id": "i9", "identifier": "HER-9", "status": "todo", "priority": "high"}
        with patch.object(server, "fetch_agents", return_value=[{"id": "pl", "name": "PL"}]), \
             patch.object(server, "call", return_value=(201, saved)) as api:
            result = server.create_task("c1", "pl", "实现登录\n补充说明", "完整描述", "high")
        self.assertTrue(result["ok"])
        self.assertEqual(result["issue"], "HER-9")
        self.assertNotIn("issues:c1", server._CACHE)
        method, path, payload = api.call_args.args
        self.assertEqual((method, path), ("POST", "/api/companies/c1/issues"))
        self.assertEqual(payload["title"], "实现登录")
        self.assertEqual(payload["description"], "完整描述")
        self.assertEqual(payload["assigneeAgentId"], "pl")
        self.assertEqual(payload["status"], "todo")
        self.assertEqual(payload["priority"], "high")

    def test_create_task_validates_agent_title_and_priority(self):
        with patch.object(server, "fetch_agents", return_value=[]):
            self.assertFalse(server.create_task("c1", "missing", "标题")["ok"])
        server._CACHE.clear()
        with patch.object(server, "fetch_agents", return_value=[{"id": "pl"}]), \
             patch.object(server, "call", return_value=(201, {"identifier": "HER-1"})) as api:
            self.assertFalse(server.create_task("c1", "pl", "   ")["ok"])
            server.create_task("c1", "pl", "标题", priority="urgent")
        payload = api.call_args.args[2]
        self.assertNotIn("priority", payload)

    def test_no_checklist_and_no_runs_stay_empty(self):
        data = self.load([issue("i1", "HER-1", "todo")])
        task = data["tasks"][0]
        self.assertIsNone(task["checklist"])
        self.assertEqual(task["runs"]["total"], 0)
        self.assertEqual(task["comments"], {"total": 0, "latest": []})


if __name__ == "__main__":
    unittest.main()
