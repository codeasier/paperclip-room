"""成员属性 GET/POST /api/member-config 与共享 apply_member_patch（门禁 T01–T11）。"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.paperclip_room import services as server
from backend.paperclip_room.http import Handler


AGENT = {
    "id": "backend",
    "name": "Backend",
    "title": "后端",
    "adapterConfig": {
        "model": "glm-5.3",
        "timeoutSec": 3600,
        "hermesCommand": "/bin/hermes",
        "env": {"FOO": "bar"},
        "persistSession": True,
    },
    "runtimeConfig": {"heartbeat": {"enabled": True, "maxConcurrentRuns": 2}},
}


class MemberConfigUnitTests(unittest.TestCase):
    def setUp(self):
        server._CACHE.clear()
        self.writes = []

    def _agent(self, **overrides):
        data = json.loads(json.dumps(AGENT))
        for key, value in overrides.items():
            if key in ("adapterConfig", "runtimeConfig") and isinstance(value, dict):
                data[key] = {**data.get(key, {}), **value}
            else:
                data[key] = value
        return data

    def _call(self, method, path, body=None, agent=None):
        agent = agent or self._agent()
        self.writes.append((method, path, body))
        if method == "GET" and path.startswith("/api/agents/") and "instructions-bundle" not in path:
            return 200, agent
        if method == "GET" and path.endswith("/instructions-bundle"):
            return 404, {"error": "not found"}
        if method == "PATCH" and path.startswith("/api/agents/"):
            # 模拟 Paperclip 合并后回写
            updated = self._agent()
            if body and "adapterConfig" in body:
                updated["adapterConfig"] = body["adapterConfig"]
            if body and "runtimeConfig" in body:
                updated["runtimeConfig"] = body["runtimeConfig"]
            if body and "name" in body:
                updated["name"] = body["name"]
            if body and "title" in body:
                updated["title"] = body["title"]
            return 200, updated
        if method == "PUT" and "instructions-bundle/file" in path:
            return 200, {"ok": True}
        return 404, {"error": "unexpected"}

    def test_t01_timeout_1199_rejected_zero_writes(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call) as api:
            result = server.apply_member_patch("c1", "backend", {"timeoutSec": 1199})
        self.assertFalse(result["ok"])
        self.assertEqual(result["field"], "timeoutSec")
        self.assertEqual(result.get("httpStatus"), 400)
        self.assertFalse(any(m in ("PATCH", "PUT") for m, _, _ in self.writes))
        # call 不应在校验失败前发出写；允许未调用或仅未写
        write_calls = [c for c in api.call_args_list if c.args and c.args[0] in ("PATCH", "PUT")]
        self.assertEqual(write_calls, [])

    def test_t02_timeout_1200_only_that_key(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call):
            result = server.apply_member_patch("c1", "backend", {"timeoutSec": 1200})
        self.assertTrue(result["ok"])
        self.assertEqual(result["applied"], ["timeoutSec"])
        patches = [b for m, p, b in self.writes if m == "PATCH"]
        self.assertEqual(len(patches), 1)
        cfg = patches[0]["adapterConfig"]
        self.assertEqual(cfg["timeoutSec"], 1200)
        self.assertEqual(cfg["hermesCommand"], "/bin/hermes")
        self.assertEqual(cfg["env"], {"FOO": "bar"})
        self.assertEqual(cfg["model"], "glm-5.3")
        self.assertNotIn("runtimeConfig", patches[0])

    def test_t03_max_concurrent_bounds(self):
        with patch.object(server, "agents_for", return_value=[AGENT]):
            for bad in (-1, 9, "x"):
                self.writes.clear()
                with patch.object(server, "call", side_effect=self._call):
                    result = server.apply_member_patch("c1", "backend", {"maxConcurrentRuns": bad})
                self.assertFalse(result["ok"], bad)
                self.assertEqual(result["field"], "maxConcurrentRuns")
                self.assertFalse(any(m == "PATCH" for m, _, _ in self.writes))
            for good in (0, 8):
                self.writes.clear()
                with patch.object(server, "call", side_effect=self._call):
                    result = server.apply_member_patch("c1", "backend", {"maxConcurrentRuns": good})
                self.assertTrue(result["ok"], good)
                patches = [b for m, _, b in self.writes if m == "PATCH"]
                self.assertEqual(patches[0]["runtimeConfig"]["heartbeat"]["maxConcurrentRuns"], good)

    def test_t04_unknown_key_rejects_whole_body(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call):
            result = server.apply_member_patch("c1", "backend", {"model": "x", "hermesCommand": "/evil"})
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("httpStatus"), 400)
        self.assertFalse(any(m == "PATCH" for m, _, _ in self.writes))

    def test_t05_cross_team_404_zero_patch(self):
        with patch.object(server, "agents_for", return_value=[]), \
             patch.object(server, "call", side_effect=self._call) as api:
            result = server.apply_member_patch("c1", "backend", {"model": "glm-5.3"})
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("httpStatus"), 404)
        api.assert_not_called()

    def test_t06_model_merge_keeps_hermes_and_env(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call):
            result = server.apply_member_patch("c1", "backend", {"model": "new-model"})
        self.assertTrue(result["ok"])
        cfg = [b for m, _, b in self.writes if m == "PATCH"][0]["adapterConfig"]
        self.assertEqual(cfg["model"], "new-model")
        self.assertEqual(cfg["hermesCommand"], "/bin/hermes")
        self.assertEqual(cfg["env"], {"FOO": "bar"})

    def test_t07_api_model_shares_merge_kernel(self):
        merges = []

        def capture(method, path, body=None):
            self.writes.append((method, path, body))
            if method == "GET" and "instructions-bundle" not in path:
                return 200, self._agent()
            if method == "GET" and path.endswith("/instructions-bundle"):
                return 404, {}
            if method == "PATCH":
                merges.append(json.loads(json.dumps(body)))
                return 200, self._agent(adapterConfig=body.get("adapterConfig", AGENT["adapterConfig"]))
            return 404, {}

        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=capture):
            via_panel = server.apply_member_patch("c1", "backend", {"model": "shared-m"})
            via_composer = server.set_model("backend", "shared-m", "c1")
        self.assertTrue(via_panel["ok"])
        self.assertTrue(via_composer["ok"])
        self.assertEqual(len(merges), 2)
        self.assertEqual(merges[0]["adapterConfig"], merges[1]["adapterConfig"])
        self.assertEqual(merges[0]["adapterConfig"]["hermesCommand"], "/bin/hermes")

    def test_t08_instructions_not_writable_409(self):
        def call(method, path, body=None):
            self.writes.append((method, path, body))
            if method == "GET" and path.endswith("/instructions-bundle"):
                return 404, {}
            if method == "GET" and path.startswith("/api/agents/"):
                # 无 promptTemplate → unavailable
                agent = self._agent()
                agent["adapterConfig"].pop("promptTemplate", None)
                return 200, agent
            return 200, {}

        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=call):
            result = server.apply_member_patch("c1", "backend", {"instructions": "hello"})
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("httpStatus"), 409)
        self.assertEqual(result.get("field"), "instructions")
        self.assertFalse(any(m == "PUT" for m, _, _ in self.writes))
        self.assertFalse(any(
            m == "PATCH" and isinstance(b, dict) and "promptTemplate" in (b.get("adapterConfig") or {})
            for m, _, b in self.writes
        ))

    def test_t08b_readonly_bundle_409(self):
        def call(method, path, body=None):
            self.writes.append((method, path, body))
            if method == "GET" and path.endswith("/instructions-bundle"):
                return 200, {"entryFile": "AGENTS.md", "writable": False}
            if method == "GET" and "instructions-bundle/file" in path:
                return 200, {"content": "locked", "contentHash": "abc", "writable": False}
            if method == "GET" and path.startswith("/api/agents/"):
                return 200, self._agent()
            return 200, {}

        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=call):
            result = server.apply_member_patch("c1", "backend", {"instructions": "new"})
        self.assertEqual(result.get("httpStatus"), 409)
        self.assertFalse(any(m == "PUT" for m, _, _ in self.writes))

    def test_t09_memory_readonly_no_write_route(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call), \
             patch.object(server, "fetch_agent_runs", return_value={"available": True, "runs": []}):
            payload = server.get_member_config("c1", "backend")
        self.assertIn("memory", payload)
        for key in ("sessionReuse", "handoff", "contextSize"):
            self.assertIn(key, payload["memory"])
            self.assertIn("state", payload["memory"][key])
            self.assertIn("asOf", payload["memory"][key])
            self.assertIn("source", payload["memory"][key])
        # 无记忆写函数
        self.assertFalse(hasattr(server, "write_memory") or hasattr(server, "set_memory"))
        self.assertFalse(any(m in ("PATCH", "PUT", "POST") for m, p, _ in self.writes if "handoff" in p or "memory" in p))

    def test_t10_get_shape_and_cross_team(self):
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call), \
             patch.object(server, "fetch_agent_runs", return_value={"available": True, "runs": []}):
            payload = server.get_member_config("c1", "backend")
        for key in ("agentId", "companyId", "fetchedAt", "runtime", "identity", "memory"):
            self.assertIn(key, payload)
        for key in ("model", "timeoutSec", "maxConcurrentRuns", "maxConcurrentRunsPlatformDefault",
                    "maxConcurrentRunsCapped", "warning"):
            self.assertIn(key, payload["runtime"])
        self.assertIn("instructions", payload["identity"])
        with patch.object(server, "agents_for", return_value=[]):
            self.assertIsNone(server.get_member_config("c1", "backend"))

    def test_t11_post_invalidates_agents_and_ops_cache(self):
        server._CACHE["agents:c1"] = (0, [AGENT])
        server._CACHE["ops:c1"] = (0, {"alerts": []})
        server._CACHE["ops:issues:c1"] = (0, [])
        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=self._call):
            result = server.apply_member_patch("c1", "backend", {"model": "m2"})
        self.assertTrue(result["ok"])
        self.assertNotIn("agents:c1", server._CACHE)
        self.assertNotIn("ops:c1", server._CACHE)
        self.assertNotIn("ops:issues:c1", server._CACHE)

    def test_concurrent_gt8_other_keys_ok_but_body_gt8_rejected(self):
        hot = self._agent(runtimeConfig={"heartbeat": {"maxConcurrentRuns": 20}})
        with patch.object(server, "agents_for", return_value=[hot]), \
             patch.object(server, "call", side_effect=lambda m, p, b=None: self._call(m, p, b, agent=hot)):
            ok = server.apply_member_patch("c1", "backend", {"timeoutSec": 1800})
            bad = server.apply_member_patch("c1", "backend", {"maxConcurrentRuns": 20})
        self.assertTrue(ok["ok"])
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["field"], "maxConcurrentRuns")

    def test_get_runtime_warning_when_concurrent_gt8(self):
        hot = self._agent(runtimeConfig={"heartbeat": {"maxConcurrentRuns": 20}})
        with patch.object(server, "agents_for", return_value=[hot]), \
             patch.object(server, "call", side_effect=lambda m, p, b=None: self._call(m, p, b, agent=hot)), \
             patch.object(server, "fetch_agent_runs", return_value={"available": True, "runs": []}):
            payload = server.get_member_config("c1", "backend")
        self.assertEqual(payload["runtime"]["maxConcurrentRuns"], 20)
        self.assertEqual(payload["runtime"]["warning"], server.MEMBER_CONCURRENT_WARNING)

    def test_get_default_concurrent_when_missing(self):
        cold = self._agent(runtimeConfig={"heartbeat": {"enabled": True}})
        cold["runtimeConfig"]["heartbeat"].pop("maxConcurrentRuns", None)
        with patch.object(server, "agents_for", return_value=[cold]), \
             patch.object(server, "call", side_effect=lambda m, p, b=None: self._call(m, p, b, agent=cold)), \
             patch.object(server, "fetch_agent_runs", return_value={"available": True, "runs": []}):
            payload = server.get_member_config("c1", "backend")
        self.assertEqual(payload["runtime"]["maxConcurrentRuns"], 20)
        self.assertIsNone(payload["runtime"]["warning"])

    def test_handoff_lists_only_configured_workdir(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            handoff = root / ".handoff"
            handoff.mkdir()
            (handoff / "HER-1.md").write_text("note")
            agent = self._agent(adapterConfig={"cwd": str(root), "model": "m"})
            block = server._memory_handoff(agent)
        self.assertEqual(block["state"], "available")
        self.assertEqual(block["files"][0]["path"], ".handoff/HER-1.md")

    def test_instructions_bundle_writable_put(self):
        def call(method, path, body=None):
            self.writes.append((method, path, body))
            if method == "GET" and path.endswith("/instructions-bundle"):
                return 200, {"entryFile": "AGENTS.md"}
            if method == "GET" and "instructions-bundle/file" in path:
                return 200, {"content": "old", "contentHash": "h1"}
            if method == "GET" and path.startswith("/api/agents/"):
                return 200, self._agent()
            if method == "PUT":
                return 200, {"ok": True}
            if method == "PATCH":
                return 200, self._agent()
            return 404, {}

        with patch.object(server, "agents_for", return_value=[AGENT]), \
             patch.object(server, "call", side_effect=call):
            result = server.apply_member_patch("c1", "backend", {"instructions": "new text"})
        self.assertTrue(result["ok"])
        self.assertIn("instructions", result["applied"])
        puts = [b for m, p, b in self.writes if m == "PUT"]
        self.assertEqual(puts[0]["content"], "new text")
        self.assertEqual(puts[0]["baseHash"], "h1")


class MemberConfigHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode() or "null")

    def test_http_get_and_post_contract(self):
        payload = {
            "agentId": "backend", "companyId": "c1", "fetchedAt": "t",
            "runtime": {"model": "m", "timeoutSec": 3600, "maxConcurrentRuns": 2,
                        "maxConcurrentRunsPlatformDefault": 20, "maxConcurrentRunsCapped": False, "warning": None},
            "identity": {"name": "Backend", "title": "后端",
                         "instructions": {"mode": "unavailable", "source": None, "path": None,
                                          "content": "", "probeNote": "x"}},
            "memory": {"sessionReuse": {"state": "unknown", "detail": "", "source": "s", "asOf": "t"},
                       "handoff": {"state": "unavailable", "files": [], "source": "s", "asOf": "t"},
                       "contextSize": {"state": "unavailable", "approxChars": None, "unit": "chars",
                                       "source": "HERMES_DB", "asOf": "t"}},
        }
        with patch.object(server, "resolve_company", return_value="c1"), \
             patch.object(server, "get_member_config", return_value=payload):
            code, body = self.request("/api/member-config?company=c1&agent=backend")
        self.assertEqual(code, 200)
        self.assertEqual(body["agentId"], "backend")
        self.assertIn("memory", body)

        with patch.object(server, "resolve_company", return_value="c1"), \
             patch.object(server, "get_member_config", return_value=None):
            self.assertEqual(self.request("/api/member-config?company=c1&agent=other")[0], 404)

        with patch.object(server, "resolve_company", return_value="c1"), \
             patch.object(server, "apply_member_patch", return_value={
                 "ok": False, "error": "超时须 ≥ 1200 秒（与巡检一致）", "field": "timeoutSec", "httpStatus": 400,
             }) as apply:
            code, body = self.request("/api/member-config?company=c1", {"agentId": "backend", "timeoutSec": 1199})
        self.assertEqual(code, 400)
        self.assertEqual(body["field"], "timeoutSec")
        apply.assert_called_once()

        with patch.object(server, "resolve_company", return_value="c1"), \
             patch.object(server, "apply_member_patch", return_value={
                 "ok": False, "error": "当前 instructions 不可写", "field": "instructions", "httpStatus": 409,
             }):
            code, body = self.request("/api/member-config?company=c1", {"agentId": "backend", "instructions": "x"})
        self.assertEqual(code, 409)

        with patch.object(server, "resolve_company", return_value="c1"), \
             patch.object(server, "apply_member_patch", return_value={
                 "ok": True, "applied": ["model"], "runtime": {}, "identity": {"name": "Backend", "title": "后端"},
             }):
            code, body = self.request("/api/member-config?company=c1", {"agentId": "backend", "model": "m"})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])


if __name__ == "__main__":
    unittest.main()
