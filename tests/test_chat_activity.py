"""对话回合进行中的实时步骤：思考、工具调用与输出。"""
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server


class ChatActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.db"
        self.db = sqlite3.connect(self.path)
        self.db.execute(
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT,"
            " reasoning_content TEXT)"
        )
        self.patch = patch.object(server, "HERMES_DB", self.path)
        self.patch.start()
        server._CACHE.clear()
        self.started = 1792865308.0  # 2026-10-24T18:08:28Z
        self.run_meta = {
            "id": "run-1",
            "agentId": "pl",
            "companyId": "c1",
            "sessionIdAfter": "session-1",
            "startedAt": "2026-10-24T18:08:28Z",
            "status": "running",
        }

    def tearDown(self):
        self.patch.stop()
        self.db.close()
        self.temp.cleanup()

    def add(self, mid, role, content="", calls=None, name=None, ts=None, reasoning=""):
        self.db.execute(
            "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                mid, "session-1", role, content,
                json.dumps(calls) if calls else None,
                "call-1" if role == "tool" else None,
                name, self.started + 10 + mid if ts is None else ts,
                reasoning, reasoning,
            ),
        )
        self.db.commit()

    def test_thinking_command_and_result_are_read_in_order(self):
        self.add(1, "assistant", "", [{"id": "call-1", "function": {"name": "terminal", "arguments": '{"command":"git status"}'}}],
                 reasoning="先看一下工作区状态，再决定是否拉取。")
        self.add(2, "tool", '{"output":"clean","exit_code":0}', name="terminal")
        data = server.chat_activity(self.run_meta)
        self.assertEqual(data["state"], "available")
        self.assertEqual([step["kind"] for step in data["steps"]], ["thinking", "tool_call", "tool_result"])
        self.assertEqual(data["steps"][0]["text"], "先看一下工作区状态，再决定是否拉取。")
        self.assertEqual(data["steps"][1]["name"], "terminal")
        self.assertEqual(data["steps"][1]["text"], "git status")
        self.assertFalse(data["steps"][2]["isError"])

    def test_secrets_in_thinking_and_commands_are_redacted(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"}'}}],
                 reasoning="API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz 先导出再调用")
        text = json.dumps(server.chat_activity(self.run_meta), ensure_ascii=False)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123", text)
        self.assertNotIn("sk-live-abcdefghijklmnopqrstuvwxyz", text)
        self.assertIn("已隐藏凭据", text)

    def test_other_runs_in_the_same_session_are_not_mixed_in(self):
        self.add(1, "assistant", "上一轮的命令", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"old"}'}}],
                 ts=self.started - 600)
        self.add(2, "assistant", "本轮的命令", [{"id": "c2", "function": {"name": "terminal", "arguments": '{"command":"new"}'}}])
        data = server.chat_activity(self.run_meta)
        text = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("old", text)
        self.assertIn("new", text)

    def test_missing_session_and_empty_window_are_distinguishable(self):
        unavailable = server.chat_activity({**self.run_meta, "sessionIdAfter": None})
        self.assertEqual(unavailable["state"], "unavailable")
        pending = server.chat_activity(self.run_meta)
        self.assertEqual(pending["state"], "pending")
        self.assertEqual(pending["steps"], [])

    def test_error_results_are_flagged_and_long_text_is_truncated(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"false"}'}}])
        self.add(2, "tool", '{"output":"boom","exit_code":1}', name="terminal")
        data = server.chat_activity(self.run_meta)
        self.assertTrue(data["steps"][-1]["isError"])

    def test_tool_output_json_wrapper_is_stripped(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"ls"}'}}])
        self.add(2, "tool", '{"output":"a.txt\\nb.txt","exit_code":0}', name="terminal")
        steps = server.chat_activity(self.run_meta)["steps"]
        self.assertEqual(steps[-1]["text"], "a.txt\nb.txt")

    def test_activity_is_bounded(self):
        for mid in range(1, 40):
            self.add(mid, "assistant", f"step-{mid}", reasoning=f"think-{mid}")
        data = server.chat_activity(self.run_meta)
        self.assertEqual(len(data["steps"]), server.CHAT_ACTIVITY_STEPS)
        self.assertEqual(data["steps"][-1]["text"], "step-39")
        self.assertEqual(data["steps"][0]["text"], "think-35")


if __name__ == "__main__":
    unittest.main()
