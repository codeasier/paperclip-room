"""巡检处理入口：固定样本 + call 打桩，不访问 Paperclip 实例。"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


AGENTS = [{"id": "pl", "name": "PL", "status": "idle"}]
NOW = datetime.now(timezone.utc)


def iso(minutes_ago=0):
    return (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


ISSUE = {
    "id": "11111111-1111-4111-8111-111111111111",
    "identifier": "HER-1",
    "title": "阻塞任务",
    "status": "blocked",
    "assigneeAgentId": "pl",
    "createdAt": iso(2000),
    "updatedAt": iso(300),
    "lastActivityAt": iso(120),
    "blockedTransitionAt": iso(300),
    "unblockDescriptor": {"owner": "board", "action": "授权合入 PR #1"},
}

QUESTIONS_INTERACTION = {
    "id": "22222222-2222-4222-8222-222222222222",
    "kind": "ask_user_questions",
    "status": "pending",
    "title": "上线方式",
    "summary": "需要你选择发布通道",
    "createdAt": iso(90),
    "payload": {
        "version": 1,
        "submitLabel": "提交选择",
        "questions": [
            {
                "id": "channel",
                "prompt": "走哪条发布通道？",
                "helpText": "灰度会先放 10% 流量",
                "selectionMode": "single",
                "required": True,
                "options": [
                    {"id": "canary", "label": "灰度发布", "description": "10% 流量"},
                    {"id": "full", "label": "全量发布"},
                    {"id": "custom", "label": "我来描述", "freeText": True},
                ],
            },
            {
                "id": "notify",
                "prompt": "要通知谁？",
                "selectionMode": "multi",
                "options": [{"id": "qa", "label": "QA"}],
            },
        ],
    },
}

CONFIRMATION_INTERACTION = {
    "id": "33333333-3333-4333-8333-333333333333",
    "kind": "request_checkbox_confirmation",
    "status": "pending",
    "createdAt": iso(60),
    "payload": {
        "version": 1,
        "prompt": "勾选要保留的项",
        "acceptLabel": "保留所选",
        "rejectLabel": "全部撤销",
        "rejectRequiresReason": True,
        "options": [{"id": "a", "label": "选项 A"}],
    },
}

EXPIRED_INTERACTION = {
    "id": "44444444-4444-4444-8444-444444444444",
    "kind": "ask_user_questions",
    "status": "expired",
    "createdAt": iso(600),
    "payload": {},
}


class Recorder:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, method, path, body=None):
        self.calls.append({"method": method, "path": path, "body": body})
        for item in self.responses:
            if item["method"] == method and item["path"] == path:
                return item["status"], item.get("data")
        return 404, {"error": "not found"}


class IssueGateTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    def gate(self, issue_ref="11111111-1111-4111-8111-111111111111", issue=None,
             interactions=None):
        interactions = [QUESTIONS_INTERACTION, CONFIRMATION_INTERACTION, EXPIRED_INTERACTION] \
            if interactions is None else interactions
        with patch.object(server, "fetch_agents", return_value=AGENTS), \
             patch.object(server, "fetch_all_issues", return_value=[issue or ISSUE]), \
             patch.object(server, "fetch_issue_interactions", return_value=interactions):
            return server.issue_gate("company", issue_ref)

    def test_gate_resolves_blocked_and_pending_interactions(self):
        payload = self.gate()
        self.assertEqual(payload["state"], "available")
        self.assertEqual(payload["issue"]["identifier"], "HER-1")
        self.assertEqual(payload["issue"]["owner"], "PL")
        blocked = payload["blocked"]
        self.assertEqual(blocked["waitingOn"], "用户")
        self.assertEqual(blocked["action"], "授权合入 PR #1")
        self.assertTrue(blocked["onBoard"])
        self.assertGreater(blocked["ageHours"], 4)
        kinds = {item["kind"] for item in payload["interactions"]}
        self.assertEqual(kinds, {"ask_user_questions", "request_checkbox_confirmation"})
        questions_card = payload["interactions"][0]
        self.assertEqual(questions_card["submitLabel"], "提交选择")
        question = questions_card["questions"][0]
        self.assertTrue(question["required"])
        self.assertEqual(question["selectionMode"], "single")
        self.assertEqual(question["options"][2]["freeText"], True)
        confirmation = payload["interactions"][1]["confirmation"]
        self.assertEqual(confirmation["prompt"], "勾选要保留的项")
        self.assertTrue(confirmation["rejectRequiresReason"])

    def test_gate_resolves_by_identifier(self):
        payload = self.gate("HER-1")
        self.assertEqual(payload["state"], "available")
        self.assertEqual(payload["issue"]["id"], ISSUE["id"])

    def test_gate_unblocked_issue_has_no_blocked_view(self):
        open_issue = dict(ISSUE, status="in_progress", unblockDescriptor=None)
        payload = self.gate(issue=open_issue)
        self.assertIsNone(payload["blocked"])

    def test_gate_unknown_issue_is_unavailable(self):
        payload = self.gate("MISSING-9")
        self.assertEqual(payload["state"], "unavailable")
        self.assertEqual(payload["interactions"], [])

    def test_gate_reuses_issue_window_cache(self):
        fetches = []

        def load(company):
            fetches.append(company)
            return [ISSUE]

        with patch.object(server, "fetch_agents", return_value=AGENTS), \
             patch.object(server, "fetch_all_issues", side_effect=load), \
             patch.object(server, "fetch_issue_interactions", return_value=[]):
            server.issue_gate("company", ISSUE["id"])
            server.issue_gate("company", "HER-1")
        self.assertEqual(len(fetches), 1)

    def test_respond_interaction_proxies_and_invalidates(self):
        recorder = Recorder([{
            "method": "POST",
            "path": "/api/issues/11111111-1111-4111-8111-111111111111/interactions/"
                    "22222222-2222-4222-8222-222222222222/respond",
            "status": 200,
            "data": {"status": "answered"},
        }])
        server._CACHE["ops:interactions:" + ISSUE["id"]] = (0, [QUESTIONS_INTERACTION])
        server._CACHE["ops:company"] = (0, {})
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            result = server.respond_interaction(
                "company", ISSUE["id"], QUESTIONS_INTERACTION["id"],
                [{"questionId": "channel", "optionIds": ["canary"]},
                 {"questionId": "notify", "optionIds": [], "otherText": "顺便叫上运维"}])
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "answered")
        self.assertEqual(len(recorder.calls), 1)
        self.assertEqual(recorder.calls[0]["body"], {
            "answers": [
                {"questionId": "channel", "optionIds": ["canary"]},
                {"questionId": "notify", "optionIds": [], "otherText": "顺便叫上运维"},
            ],
        })
        self.assertNotIn("ops:interactions:" + ISSUE["id"], server._CACHE)
        self.assertNotIn("ops:company", server._CACHE)

    def test_respond_interaction_rejects_dirty_answers(self):
        recorder = Recorder([])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            for bad in ([], "nope", [{"questionId": ""}], [{"questionId": "q", "optionIds": [""]}]):
                result = server.respond_interaction(
                    "company", ISSUE["id"], QUESTIONS_INTERACTION["id"], bad)
                self.assertFalse(result["ok"])
        self.assertEqual(recorder.calls, [])

    def test_respond_interaction_rejects_foreign_issue(self):
        recorder = Recorder([])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            result = server.respond_interaction(
                "company", "99999999-9999-4999-8999-999999999999",
                QUESTIONS_INTERACTION["id"], [{"questionId": "q", "optionIds": ["a"]}])
        self.assertFalse(result["ok"])
        self.assertEqual(recorder.calls, [])

    def test_respond_interaction_surfaces_upstream_error(self):
        recorder = Recorder([{
            "method": "POST",
            "path": "/api/issues/11111111-1111-4111-8111-111111111111/interactions/"
                    "22222222-2222-4222-8222-222222222222/respond",
            "status": 422,
            "data": {"error": "Only ask_user_questions interactions can be answered"},
        }])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            result = server.respond_interaction(
                "company", ISSUE["id"], QUESTIONS_INTERACTION["id"],
                [{"questionId": "q", "optionIds": ["a"]}])
        self.assertFalse(result["ok"])
        self.assertIn("Only ask_user_questions", result["error"])

    def test_resolve_interaction_accept_and_reject(self):
        base = "/api/issues/11111111-1111-4111-8111-111111111111/interactions/33333333-3333-4333-8333-333333333333"
        recorder = Recorder([
            {"method": "POST", "path": base + "/accept", "status": 200, "data": {"status": "accepted"}},
            {"method": "POST", "path": base + "/reject", "status": 200, "data": {"status": "rejected"}},
        ])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            accepted = server.resolve_interaction(
                "company", ISSUE["id"], CONFIRMATION_INTERACTION["id"], "accept",
                selected_option_ids=["a", "b"])
            rejected = server.resolve_interaction(
                "company", ISSUE["id"], CONFIRMATION_INTERACTION["id"], "reject",
                reason="不要保留")
            bad = server.resolve_interaction(
                "company", ISSUE["id"], CONFIRMATION_INTERACTION["id"], "maybe")
        self.assertTrue(accepted["ok"])
        self.assertEqual(recorder.calls[0]["body"], {"selectedOptionIds": ["a", "b"]})
        self.assertTrue(rejected["ok"])
        self.assertEqual(recorder.calls[1]["body"], {"reason": "不要保留"})
        self.assertFalse(bad["ok"])

    def test_reply_issue_sends_reopen_and_client_request_id(self):
        recorder = Recorder([{
            "method": "POST",
            "path": "/api/issues/11111111-1111-4111-8111-111111111111/comments",
            "status": 200,
            "data": {"id": "c1"},
        }])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            result = server.reply_issue("company", ISSUE["id"], "已授权，继续", True)
            empty = server.reply_issue("company", ISSUE["id"], "  ", False)
        self.assertTrue(result["ok"])
        self.assertTrue(result["reopened"])
        body = recorder.calls[0]["body"]
        self.assertEqual(body["body"], "已授权，继续")
        self.assertTrue(body["reopen"])
        self.assertIn("clientRequestId", body)
        self.assertFalse(empty["ok"])

    def test_reply_issue_requires_uuid(self):
        recorder = Recorder([])
        with patch.object(server, "fetch_all_issues", return_value=[ISSUE]), \
             patch.object(server, "call", side_effect=recorder):
            result = server.reply_issue("company", "HER-1", "文本", True)
        self.assertFalse(result["ok"])
        self.assertEqual(recorder.calls, [])


if __name__ == "__main__":
    unittest.main()
