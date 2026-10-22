"""Agent Chat 代理：会话读取、消息归属与发送。"""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


AGENTS = [{"id": "pl", "name": "PL"}, {"id": "qa", "name": "QA"}]
CHAT = {
    "id": "chat-1", "companyId": "c1", "conversationAgentId": "pl",
    "conversationState": "waiting", "identifier": "HER-97",
    "status": "in_review", "updatedAt": "2026-10-22T14:10:00Z",
}
COMMENTS = [
    {"id": "m1", "authorUserId": "local-board", "authorType": "user", "body": "你好",
     "createdAt": "2026-10-22T14:10:01Z"},
    {"id": "m2", "authorAgentId": "pl", "authorType": "agent", "body": "OK",
     "createdAt": "2026-10-22T14:10:20Z"},
    {"id": "m3", "authorAgentId": "pl", "body": "已删除", "deletedAt": "2026-10-22T14:11:00Z",
     "createdAt": "2026-10-22T14:10:30Z"},
]


class ChatTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()

    @contextmanager
    def mocked(self, routes):
        calls = []

        def fake_call(method, path, body=None):
            calls.append((method, path, body))
            for (expected_method, prefix), result in routes:
                if method == expected_method and path.startswith(prefix):
                    return result
            return 404, {"error": "not found"}

        with patch.object(server, "fetch_agents", return_value=AGENTS), \
             patch.object(server, "call", side_effect=fake_call):
            yield calls

    def test_new_conversation_is_not_created_by_reading(self):
        with self.mocked([(("GET", "/api/companies/c1/chats/pl"), (200, None))]) as calls:
            data = server.chat_snapshot("c1", "pl")
        self.assertEqual(data["state"], "new")
        self.assertIsNone(data["chat"])
        self.assertEqual(data["messages"], [])
        self.assertEqual(len(calls), 1)

    def test_available_conversation_maps_user_and_agent_messages(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (200, CHAT)),
            (("GET", "/api/issues/chat-1/comments"), (200, COMMENTS)),
        ]):
            data = server.chat_snapshot("c1", "pl")
        self.assertEqual(data["state"], "available")
        self.assertEqual(data["chat"]["identifier"], "HER-97")
        self.assertEqual([message["author"] for message in data["messages"]], ["user", "agent"])
        self.assertEqual([message["authorName"] for message in data["messages"]], ["我", "PL"])
        self.assertEqual(data["messages"][1]["text"], "OK")

    def test_disabled_chat_is_explicit(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (404, {"error": "Agent Chat is disabled"})),
        ]):
            data = server.chat_snapshot("c1", "pl")
        self.assertEqual(data["state"], "disabled")
        self.assertIn("尚未启用", data["note"])

    def test_chat_from_other_company_is_rejected(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (200, {**CHAT, "companyId": "other"})),
        ]):
            data = server.chat_snapshot("c1", "pl")
        self.assertEqual(data["state"], "unavailable")

    def test_missing_comments_are_not_reported_as_empty_chat(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (200, CHAT)),
            (("GET", "/api/issues/chat-1/comments"), (503, {})),
        ]):
            data = server.chat_snapshot("c1", "pl")
        self.assertEqual(data["state"], "unavailable")
        self.assertEqual(data["messages"], [])

    def test_send_uses_existing_conversation_and_client_request_id(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (200, CHAT)),
            (("POST", "/api/issues/chat-1/comments"), (201, {"id": "m9"})),
        ]) as calls:
            result = server.send_chat("c1", "pl", "你好")
        self.assertTrue(result["ok"])
        post = next(item for item in calls if item[0] == "POST")
        self.assertTrue(post[2]["clientRequestId"])
        self.assertEqual(post[2]["body"], "你好")

    def test_send_opens_conversation_on_first_message(self):
        with self.mocked([
            (("GET", "/api/companies/c1/chats/pl"), (200, None)),
            (("POST", "/api/companies/c1/chats/pl"), (200, CHAT)),
            (("POST", "/api/issues/chat-1/comments"), (201, {"id": "m9"})),
        ]) as calls:
            result = server.send_chat("c1", "pl", "第一条")
        self.assertTrue(result["ok"])
        self.assertEqual([method for method, _, _ in calls], ["GET", "POST", "POST"])
        self.assertEqual(calls[1][1], "/api/companies/c1/chats/pl")

    def test_send_reports_disabled_and_unknown_agent(self):
        def fake_call(method, path, body=None):
            return 404, {"error": "Agent Chat is disabled"}

        with patch.object(server, "fetch_agents", return_value=AGENTS), \
             patch.object(server, "call", side_effect=fake_call):
            result = server.send_chat("c1", "pl", "你好")
            unknown = server.send_chat("c1", "missing", "你好")
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "disabled")
        self.assertFalse(unknown["ok"])

    def test_agent_is_scoped_to_company(self):
        with patch.object(server, "fetch_agents",
                          side_effect=lambda company=None: AGENTS if company == "c1" else []):
            data = server.chat_snapshot("c2", "pl")
        self.assertEqual(data["state"], "unavailable")
        self.assertIn("成员不存在", data["note"])


if __name__ == "__main__":
    unittest.main()
