"""通信对象与转派后历史消息：使用固定样本，不访问 Paperclip 实例。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


AGENTS = [{"id": name.lower(), "name": name} for name in server.ROLE_ALIASES]
ISSUE = {"id": "issue-89", "identifier": "HER-89", "title": "补回 CHANGELOG", "assigneeAgentId": "pl"}


class CommunicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = server.recipient_directory(AGENTS)
        server._CACHE.clear()

    def event(self, body, author="backend", selected="pl", issue=None, **extra):
        comment = {"id": "comment-1", "authorAgentId": author, "body": body, "createdAt": "2026-10-22T07:00:00Z", **extra}
        return server.comment_event(comment, issue or ISSUE, selected, self.directory)

    def test_explicit_header_overrides_current_assignee(self):
        event = self.event("[交接] 给 @架构师\n- 做了什么：已完成")
        self.assertEqual(event["sender"]["name"], "Backend")
        self.assertEqual(event["recipients"][0]["name"], "Architect")
        self.assertEqual(event["dir"], "related")  # 不是发给当前负责人 PL 的来信
        self.assertEqual(event["recipientSource"], "explicit_header")
        self.assertEqual(event["id"], "comment-1")
        self.assertEqual(event["issueTitle"], "补回 CHANGELOG")

    def test_incoming_after_reassignment(self):
        event = self.event("[交接] 给 @架构师", selected="architect")
        self.assertEqual(event["dir"], "in")

    def test_outgoing_direction(self):
        event = self.event("[交接] 给 @PL", author="architect", selected="architect")
        self.assertEqual(event["dir"], "out")
        self.assertEqual(event["recipients"][0]["id"], "pl")

    def test_unaddressed_comment_targets_thread_not_assignee(self):
        event = self.event("结论：检查通过。\n下一步请 @Architect 评审。")
        moved = self.event("结论：检查通过。\n下一步请 @Architect 评审。", issue={**ISSUE, "assigneeAgentId": "qa"})
        self.assertEqual(event, moved)
        self.assertEqual(event["recipients"], [{"kind": "issue", "id": "issue-89", "name": "HER-89 讨论区"}])
        self.assertEqual(event["dir"], "related")

    def test_quotes_code_and_mentions_are_not_addresses(self):
        for body in ("> [交接] 给 @PL", "```text\n[交接] 给 @PL\n```", "记录：曾给 @PL 留言", "请检查 @PL 的回复"):
            with self.subTest(body=body):
                self.assertEqual(self.event(body)["recipientSource"], "issue_thread")

    def test_recipients_only_before_title(self):
        event = self.event("[收口] 给 @PL — 通过；后续请 @QA 回归", author="architect")
        self.assertEqual([x["name"] for x in event["recipients"]], ["PL"])

    def test_multiple_aliases_and_markdown_header(self):
        event = self.event("\n## **[交接] 给 @PL、@测试、@qa**")
        self.assertEqual([x["name"] for x in event["recipients"]], ["PL", "QA"])
        self.assertEqual(self.event("给 CICD")["recipients"][0]["name"], "DevOps")
        self.assertEqual(self.event("To: @frontend")["recipients"][0]["name"], "Frontend")
        self.assertEqual([x["name"] for x in self.event("给 @PL @QA")["recipients"]], ["PL", "QA"])

    def test_unknown_explicit_name_is_not_mapped_to_current_owner(self):
        event = self.event("[交接] 给 @Security")
        self.assertEqual(event["recipients"], [{"kind": "mentioned", "id": None, "name": "Security"}])

    def test_user_and_system_sources(self):
        event = self.event("补充需求", author=None, authorUserId="board-user")
        self.assertEqual(event["sender"]["name"], "用户")
        self.assertEqual(event["recipientSource"], "issue_thread")
        self.assertEqual(self.event("系统通知", author=None)["sender"]["name"], "系统")

    def test_derived_author_and_unknown_agent(self):
        self.assertEqual(self.event("给 @PL", author=None, derivedAuthorAgentId="architect")["sender"]["name"], "Architect")
        self.assertEqual(self.event("给 @PL", author="unknown")["sender"]["name"], "未知成员")

    def test_recipient_user(self):
        event = self.event("[待决策] 给 @用户")
        self.assertEqual(event["recipients"][0]["kind"], "user")

    def test_timeline_includes_incoming_on_reassigned_issue(self):
        comments = [
            {"id": "in", "authorAgentId": "backend", "body": "[交接] 给 @架构师"},
            {"id": "out", "authorAgentId": "architect", "body": "[交接] 给 @PL"},
            {"id": "other", "authorAgentId": "backend", "body": "仅任务讨论"},
            {"id": "deleted", "authorAgentId": "backend", "body": "给 @架构师", "deletedAt": "2026-10-22"},
        ]
        with patch.object(server, "fetch_agents", return_value=AGENTS), patch.object(server, "fetch_issues", return_value=[ISSUE]), patch.object(server, "fetch_comments", return_value=comments), patch.object(server, "fetch_receipt_runs", return_value={"available": True, "runs": [], "limit": 200}):
            events = server.room_timeline("architect")["events"]
            self.assertEqual([e.get("id") for e in events if e["kind"] == "comment"], ["in", "out"])
            self.assertEqual(sum(e["kind"] == "issue" for e in events), 1)
            # 当前负责人能看完整讨论，但其他角色间交接不能冒充发给负责人的来信。
            own = server.room_timeline("pl")["events"]
            self.assertEqual([e["dir"] for e in own if e["kind"] == "comment"], ["related", "in", "related"])

    def receipts(self, runs, available=True):
        event = self.event("任务讨论")
        server.attach_receipts([event], {"available": available, "runs": runs, "limit": 200}, self.directory)
        return event["receipt"]

    def sample_run(self, **kwargs):
        return {"id": "run-1", "agentId": "pl", "status": "running", "createdAt": "2026-10-22T07:01:00Z", "contextSnapshot": {"issueId": ISSUE["id"], "commentId": "comment-1", "wakeCommentId": "comment-1"}, **kwargs}

    def test_receipt_exact_match_deduplicates_two_context_fields(self):
        receipt = self.receipts([self.sample_run(), self.sample_run()])
        self.assertEqual(receipt["state"], "matched")
        self.assertEqual(len(receipt["runs"]), 1)
        self.assertEqual(receipt["runs"][0]["agentName"], "PL")
        self.assertFalse(receipt["scope"]["complete"])

    def test_receipt_needs_same_issue_and_comment(self):
        contexts = [
            {"issueId": ISSUE["id"], "commentId": "other"},
            {"issueId": "other", "commentId": "comment-1"},
            {"issueId": ISSUE["id"]},
            {"commentId": "comment-1"},
            {"issueId": ISSUE["id"], "taskId": "conflicting", "commentId": "comment-1"},
        ]
        self.assertEqual(self.receipts([self.sample_run(contextSnapshot=c) for c in contexts])["state"], "not_found")

    def test_receipt_all_attempts_and_agents_newest_first(self):
        old = self.sample_run(status="failed")
        new = self.sample_run(id="run-2", agentId="architect", status="queued", createdAt="2026-10-22T08:00:00Z", contextSnapshot={"taskId": ISSUE["id"], "wakeCommentId": "comment-1"})
        receipt = self.receipts([old, new])
        self.assertEqual([r["runId"] for r in receipt["runs"]], ["run-2", "run-1"])
        self.assertEqual([r["agentName"] for r in receipt["runs"]], ["Architect", "PL"])

    def test_receipt_failure_distinct_from_missing_history(self):
        self.assertEqual(self.receipts([])["state"], "not_found")
        self.assertEqual(self.receipts([], available=False)["state"], "unavailable")
        with patch.object(server, "call", return_value=(503, {})):
            self.assertFalse(server.fetch_receipt_runs()["available"])
        with patch.object(server, "call", return_value=(200, {"unexpected": []})):
            self.assertFalse(server.fetch_receipt_runs()["available"])

    def test_receipt_statuses_and_absent_context(self):
        self.assertEqual(self.receipts([self.sample_run(contextSnapshot=None)])["state"], "not_found")
        for status in ("queued", "running", "succeeded", "failed", "cancelled", "timed_out"):
            self.assertEqual(self.receipts([self.sample_run(status=status)])["runs"][0]["status"], status)


if __name__ == "__main__":
    unittest.main()
