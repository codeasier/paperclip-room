"""Exercise the actual HTTP boundary with offline services and temporary built assets."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from backend.paperclip_room import config, services
from backend.paperclip_room.http import Handler


class HttpTests(unittest.TestCase):
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

    def request(self, path, body=None, raw=None):
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def test_serves_built_html_and_javascript_with_correct_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text('<div id="root"></div>')
            (root / "assets").mkdir()
            (root / "assets" / "app.js").write_text("console.log('built');")
            with patch.object(config, "STATIC_DIR", root):
                code, headers, body = self.request("/")
                self.assertEqual(code, 200)
                self.assertIn("text/html", headers["Content-Type"])
                self.assertIn(b'id="root"', body)
                code, headers, _ = self.request("/assets/app.js")
                self.assertEqual(code, 200)
                self.assertIn("javascript", headers["Content-Type"])

    def test_static_traversal_and_missing_build_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(config, "STATIC_DIR", Path(directory)):
            self.assertEqual(self.request("/")[0], 503)
            self.assertEqual(self.request("/%2e%2e/server.py")[0], 404)
            self.assertEqual(self.request("/assets/not-found.js")[0], 404)

    def test_team_scoped_api_contract(self):
        with patch.object(services, "resolve_company", return_value="c2"), patch.object(services, "agent_snapshot", return_value={"agents": []}) as snapshot:
            code, headers, body = self.request("/api/state?company=c2")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {"agents": []})
        self.assertEqual(headers["Cache-Control"], "no-store")
        snapshot.assert_called_once_with("c2")

    def test_chat_write_preserves_route_and_parameters(self):
        with patch.object(services, "resolve_company", return_value="c2"), patch.object(services, "send_chat", return_value={"ok": True}) as send:
            code, _, body = self.request("/api/chat?company=c2", {"agentId": "pl", "text": " hello "})
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(body)["ok"])
        send.assert_called_once_with("c2", "pl", "hello")

    def test_run_cannot_be_read_from_another_company_or_member(self):
        run_id = "11111111-1111-4111-8111-111111111111"
        for company, agent in [("other", "pl"), ("c2", "qa")]:
            with patch.object(services, "resolve_company", return_value="c2"), patch.object(services, "call", return_value=(200, {"companyId": company, "agentId": agent})):
                self.assertEqual(self.request(f"/api/run?company=c2&agent=pl&run={run_id}")[0], 404)

    def test_invalid_json_is_rejected_without_dispatch(self):
        with patch.object(services, "send_chat") as send:
            self.assertEqual(self.request("/api/chat", raw=b"[")[0], 400)
            self.assertEqual(self.request("/api/chat", raw=b"[]")[0], 400)
            send.assert_not_called()

    def test_model_write_requires_member_of_selected_team(self):
        with patch.object(services, "resolve_company", return_value="c2"), patch.object(services, "agents_for", return_value=[]), patch.object(services, "set_model") as change:
            self.assertEqual(self.request("/api/model?company=c2", {"agentId": "other-agent", "model": "glm-5.3"})[0], 404)
            change.assert_not_called()


if __name__ == "__main__":
    unittest.main()
