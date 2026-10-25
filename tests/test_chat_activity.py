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
        self.db.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL)")
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

    def add(self, mid, role, content="", calls=None, name=None, ts=None, reasoning="", sid="session-1", call_id="call-1"):
        self.db.execute(
            "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                mid, sid, role, content,
                json.dumps(calls) if calls else None,
                call_id if role == "tool" else None,
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
        self.assertEqual(data["steps"][1]["toolCallId"], data["steps"][2]["toolCallId"])
        self.assertFalse(data["hasEarlierSteps"])

    def test_reasoning_text_calls_and_results_stay_interleaved(self):
        self.add(1, "assistant", "先看状态", [
            {"id": "first", "function": {"name": "terminal", "arguments": '{"command":"git status"}'}},
            {"call_id": "second", "function": {"name": "terminal", "arguments": '{"command":"git diff"}'}},
        ], reasoning="先检查，再修改")
        self.add(2, "tool", "状态干净", name="terminal", call_id="first")
        self.add(3, "tool", "没有改动", name="terminal", call_id="second")
        self.add(4, "assistant", "检查结束", reasoning="可以回复了")
        steps = server.chat_activity(self.run_meta)["steps"]
        self.assertEqual([step["kind"] for step in steps], [
            "thinking", "assistant", "tool_call", "tool_call", "tool_result", "tool_result",
            "thinking", "assistant",
        ])
        self.assertEqual([step.get("toolCallId") for step in steps[2:6]],
                         ["first", "second", "first", "second"])
        self.assertEqual([step["id"] for step in steps],
                         ["r-1", "m-1", "m-1-t-0", "m-1-t-1", "t-2", "t-3", "r-4", "m-4"])
        self.assertEqual([step["ts"] for step in steps], sorted(step["ts"] for step in steps))

    def test_multiline_content_is_not_reduced_to_tiny_previews(self):
        reasoning = "推理第一行\n" + "需要保留的思考\n" * 120
        text = "回复第一行\n" + "需要保留的回复\n" * 180
        command = "printf 'first\\n'\n" + "echo more\n" * 100
        output = "输出第一行\n" + "需要保留的结果\n" * 120
        self.add(1, "assistant", text, [{"id": "call-1", "function": {
            "name": "terminal", "arguments": json.dumps({"command": command}),
        }}], reasoning=reasoning)
        self.add(2, "tool", json.dumps({"output": output, "exit_code": 0}), name="terminal")
        steps = server.chat_activity(self.run_meta)["steps"]
        self.assertEqual([step["text"] for step in steps], [reasoning.strip(), text, command, output])
        self.assertTrue(all(not step["truncated"] for step in steps))

    def test_all_activity_kinds_use_the_public_text_limit(self):
        long_text = "line of expandable content\n" * 1000
        self.add(1, "assistant", long_text, [{"id": "call-1", "function": {
            "name": "terminal", "arguments": json.dumps({"command": long_text}),
        }}], reasoning=long_text)
        self.add(2, "tool", json.dumps({"output": long_text}), name="terminal")
        steps = server.chat_activity(self.run_meta)["steps"]
        self.assertEqual(len(steps), 4)
        self.assertTrue(all(step["truncated"] for step in steps))
        self.assertTrue(all(step["text"] == long_text[:16000] for step in steps))

    def test_secrets_in_thinking_and_commands_are_redacted(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"}'}}],
                 reasoning="API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz 先导出再调用")
        text = json.dumps(server.chat_activity(self.run_meta), ensure_ascii=False)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123", text)
        self.assertNotIn("sk-live-abcdefghijklmnopqrstuvwxyz", text)
        self.assertIn("已隐藏凭据", text)

    def test_assistant_text_and_tool_results_are_redacted_too(self):
        secrets = ["ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-live-abcdefghijklmnopqrstuvwxyz",
                   "github_pat_abcdefghijklmnopqrstuvwxyz0123", "automation-secret",
                   "abcdefghijklmnopqrstuv", "zyxwvutsrqponmlkjihgfedcba"]
        content = "\n".join(secrets[:4] + ["Authorization: Bearer " + secrets[4],
                                              "API_KEY=" + secrets[5]])
        self.add(1, "assistant", content)
        self.add(2, "tool", json.dumps({"output": content}), name="terminal")
        with patch.object(server, "api_key", return_value="automation-secret"):
            data = server.chat_activity(self.run_meta)
        for secret in secrets:
            self.assertNotIn(secret, json.dumps(data))
        self.assertEqual([step["kind"] for step in data["steps"]], ["assistant", "tool_result"])
        self.assertTrue(all("已隐藏凭据" in step["text"] for step in data["steps"]))

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
        self.assertFalse(unavailable["hasEarlierSteps"])
        self.assertFalse(pending["hasEarlierSteps"])
        self.assertEqual(pending["status"], "running")
        self.assertEqual(pending["startedAt"], self.run_meta["startedAt"])

    def test_queued_run_does_not_read_or_infer_prior_session_activity(self):
        self.add(1, "assistant", "上一轮的回复", reasoning="上一轮的思考")
        for fields in ({}, {"sessionIdAfter": None, "sessionIdBefore": "session-1", "startedAt": None},
                       {"sessionIdAfter": None, "sessionIdBefore": None, "startedAt": None}):
            with self.subTest(fields=fields):
                queued = {**self.run_meta, "status": "queued", "createdAt": "2026-10-24T18:08:29Z",
                          "finishedAt": None, **fields}
                with patch.object(server, "_session_tail", wraps=server._session_tail) as tail:
                    data = server.chat_activity(queued)
                tail.assert_not_called()
                self.assertEqual(data["state"], "pending")
                self.assertEqual(data["steps"], [])
                self.assertFalse(data["hasEarlierSteps"])
                for key in ("status", "startedAt", "createdAt", "finishedAt"):
                    self.assertEqual(data[key], queued.get(key))
                self.assertNotIn("上一轮", json.dumps(data, ensure_ascii=False))

    def test_error_results_are_flagged(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"false"}'}}])
        self.add(2, "tool", '{"output":"boom","exit_code":1}', name="terminal")
        data = server.chat_activity(self.run_meta)
        self.assertTrue(data["steps"][-1]["isError"])

    def test_running_run_uses_session_before_until_finished(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"git status"}'}}])
        live = {**self.run_meta, "sessionIdAfter": None, "sessionIdBefore": "session-1"}
        data = server.chat_activity(live)
        self.assertEqual(data["state"], "available")
        self.assertEqual(data["steps"][0]["text"], "git status")

    def test_new_session_is_found_by_start_time_when_no_id_is_known(self):
        self.db.execute("INSERT INTO sessions VALUES (?,?)", ("session-2", self.started + 12))
        self.db.commit()
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"ls"}'}}], sid="session-2")
        self.assertEqual(server.chat_activity({**self.run_meta, "sessionIdAfter": None})["state"], "available")
        server._CACHE.clear()
        self.db.execute("INSERT INTO sessions VALUES (?,?)", ("session-3", self.started + 30))
        self.db.commit()
        ambiguous = server.chat_activity({**self.run_meta, "sessionIdAfter": None})
        self.assertEqual(ambiguous["state"], "unavailable")

    def test_tool_output_json_wrapper_is_stripped(self):
        self.add(1, "assistant", "", [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command":"ls"}'}}])
        self.add(2, "tool", '{"output":"a.txt\\nb.txt","exit_code":0}', name="terminal")
        steps = server.chat_activity(self.run_meta)["steps"]
        self.assertEqual(steps[-1]["text"], "a.txt\nb.txt")

    def test_more_than_ten_steps_are_retained_without_silent_tail(self):
        for mid in range(1, 40):
            self.add(mid, "assistant", f"step-{mid}", reasoning=f"think-{mid}")
        data = server.chat_activity(self.run_meta)
        self.assertEqual(len(data["steps"]), 78)
        self.assertEqual(data["steps"][-1]["text"], "step-39")
        self.assertEqual(data["steps"][0]["text"], "think-1")
        self.assertFalse(data["hasEarlierSteps"])

    def test_expanded_activity_steps_are_bounded_and_marked(self):
        for mid in range(1, 222):
            self.add(mid, "assistant", f"step-{mid}", reasoning=f"think-{mid}")
        data = server.chat_activity(self.run_meta)
        self.assertEqual(len(data["steps"]), server.CHAT_ACTIVITY_STEPS)
        self.assertEqual(data["steps"][-1]["text"], "step-221")
        self.assertEqual(data["steps"][0]["text"], "think-22")
        self.assertTrue(data["hasEarlierSteps"])

    def test_sql_tail_uses_a_bounded_row_window_plus_sentinel(self):
        for mid in range(1, 403):
            self.add(mid, "assistant", f"step-{mid}")
        statements = []
        connect = sqlite3.connect

        def traced_connect(*args, **kwargs):
            db = connect(*args, **kwargs)
            db.set_trace_callback(statements.append)
            return db

        with patch.object(server.sqlite3, "connect", side_effect=traced_connect):
            data = server.chat_activity(self.run_meta)
        self.assertEqual(len(data["steps"]), server.CHAT_ACTIVITY_STEPS)
        self.assertEqual(data["steps"][0]["text"], "step-3")
        self.assertEqual(data["steps"][-1]["text"], "step-402")
        self.assertTrue(data["hasEarlierSteps"])
        message_queries = [sql for sql in statements if "FROM messages" in sql]
        self.assertEqual(len(message_queries), 1)
        self.assertIn("LIMIT 401", message_queries[0])

    def test_exact_row_and_step_boundary_has_no_earlier_steps(self):
        for mid in range(1, 401):
            self.add(mid, "assistant", f"step-{mid}")
        data = server.chat_activity(self.run_meta)
        self.assertEqual(len(data["steps"]), server.CHAT_ACTIVITY_STEPS)
        self.assertEqual(data["steps"][0]["text"], "step-1")
        self.assertFalse(data["hasEarlierSteps"])

    def test_finished_run_window_and_cache_do_not_keep_live_tail(self):
        self.add(1, "assistant", "本轮回复", ts=self.started + 10)
        self.add(2, "assistant", "下一轮回复", ts=self.started + 60)
        live = server.chat_activity(self.run_meta)
        self.assertEqual(len(live["steps"]), 2)
        finished_at = datetime.fromtimestamp(self.started + 20, timezone.utc).isoformat()
        finished = server.chat_activity({**self.run_meta, "finishedAt": finished_at, "status": "succeeded"})
        self.assertEqual([step["text"] for step in finished["steps"]], ["本轮回复"])
        self.assertEqual(finished["finishedAt"], finished_at)
        self.assertEqual(finished["status"], "succeeded")
        # A corrected finish timestamp must not reuse the previous completed response.
        corrected = server.chat_activity({**self.run_meta, "status": "succeeded",
                                          "finishedAt": datetime.fromtimestamp(self.started + 70, timezone.utc).isoformat()})
        self.assertEqual(len(corrected["steps"]), 2)

    def test_activity_cache_varies_on_status_and_session_before_identity(self):
        self.add(1, "assistant", "first session")
        self.add(2, "assistant", "second session", sid="session-2")
        before = {**self.run_meta, "sessionIdAfter": None, "sessionIdBefore": "session-1"}
        first = server.chat_activity(before)
        second = server.chat_activity({**before, "sessionIdBefore": "session-2"})
        self.assertEqual(first["steps"][0]["text"], "first session")
        self.assertEqual(second["steps"][0]["text"], "second session")
        updated = server.chat_activity({**before, "status": "succeeded"})
        self.assertEqual(updated["status"], "succeeded")

    def test_legacy_schemas_with_missing_reasoning_columns_still_load(self):
        for column in (None, "reasoning", "reasoning_content"):
            with self.subTest(column=column):
                path = Path(self.temp.name) / f"legacy-{column}.db"
                db = sqlite3.connect(path)
                db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
                           " content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp REAL"
                           + (f", {column} TEXT" if column else "") + ")")
                assistant = [1, "session-1", "assistant", "旧版回复", json.dumps([
                    {"id": "legacy-call", "function": {"name": "terminal", "arguments": '{"command":"pwd"}'}}
                ]), None, None, self.started + 10]
                result = [2, "session-1", "tool", '{"output":"/tmp","exit_code":0}',
                          None, "legacy-call", "terminal", self.started + 11]
                if column:
                    assistant.append("兼容思考")
                    result.append("")
                placeholders = ",".join("?" for _ in assistant)
                db.executemany(f"INSERT INTO messages VALUES ({placeholders})", [assistant, result])
                db.commit()
                db.close()
                server._CACHE.clear()
                with patch.object(server, "HERMES_DB", path):
                    data = server.chat_activity(self.run_meta)
                self.assertEqual(data["state"], "available")
                self.assertEqual([step["kind"] for step in data["steps"]],
                                 (["thinking"] if column else []) + ["assistant", "tool_call", "tool_result"])
                self.assertEqual(data["steps"][-1]["toolCallId"], "legacy-call")


if __name__ == "__main__":
    unittest.main()
