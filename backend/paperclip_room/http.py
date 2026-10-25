"""Same-origin JSON API and Vite production asset serving."""
import json
import mimetypes
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import config, services as s
from .client import api_key


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[room] " + fmt % args + "\n")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _company(self, query, body=None):
        return s.resolve_company((body or {}).get("company") or query.get("company", [""])[0])

    def _static(self, path):
        root = config.STATIC_DIR.resolve()
        target = (root / ("index.html" if path == "/" else unquote(path).lstrip("/"))).resolve()
        if root not in target.parents or not target.is_file():
            message = "Frontend not built; run npm ci --prefix frontend && npm run build --prefix frontend."
            return self._send(503 if path in ("/", "/index.html") else 404, {"error": message if path == "/" else "not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return self._send(200, target.read_bytes(), ctype)

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self._static(url.path)
        query = parse_qs(url.query)
        try:
            if url.path == "/api/teams":
                return self._send(200, s.teams_payload())
            if url.path not in ("/api/state", "/api/ops", "/api/tasks", "/api/chat", "/api/room", "/api/execution", "/api/run", "/api/chat-activity", "/api/member-config", "/api/issue-gate"):
                return self._send(404, {"error": "not found"})
            company = self._company(query)
            if not company:
                return self._send(404, {"error": "team not found"})
            if url.path == "/api/state":
                return self._send(200, s.agent_snapshot(company))
            if url.path == "/api/ops":
                return self._send(200, s.cached("ops:" + company, 15, lambda: s.ops_payload(company)))
            if url.path == "/api/issue-gate":
                issue_ref = (query.get("issue", [""])[0] or "").strip()
                if not issue_ref or len(issue_ref) > 80:
                    return self._send(400, {"error": "valid issue required"})
                return self._send(200, s.issue_gate(company, issue_ref))
            aid = query.get("agent", [""])[0]
            if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", aid):
                return self._send(400, {"error": "valid agent required"})
            if url.path == "/api/member-config":
                result = s.get_member_config(company, aid)
                if result is None:
                    return self._send(404, {"error": "agent not found for this team"})
                if result.get("ok") is False:
                    return self._send(result.get("httpStatus") or 502, {"error": result.get("error")})
                public = {k: v for k, v in result.items() if not k.startswith("_")}
                return self._send(200, public)
            if url.path == "/api/tasks":
                result = s.cached(f"tasks:{company}:{aid}", 4, lambda: s.agent_tasks(aid, company))
            elif url.path == "/api/chat":
                result = s.chat_snapshot(company, aid)
            elif url.path == "/api/room":
                result = s.room_timeline(aid, company=company)
            elif url.path == "/api/execution":
                result = s.cached(f"exec:{company}:{aid}", 4, lambda: s.execution_timeline(aid, company))
            elif url.path == "/api/chat-activity":
                rid = query.get("run", [""])[0]
                if not re.fullmatch(r"[0-9a-fA-F-]{36}", rid):
                    return self._send(400, {"error": "valid run required"})
                status, run = s.call("GET", "/api/heartbeat-runs/" + rid)
                if status != 200 or not isinstance(run, dict) or run.get("companyId") != company or run.get("agentId") != aid:
                    return self._send(404, {"error": "run not found for this member"})
                result = s.chat_activity(run)
            else:
                rid = query.get("run", [""])[0]
                before = int(query.get("before", ["0"])[0])
                if not re.fullmatch(r"[0-9a-fA-F-]{36}", rid) or before < 0:
                    return self._send(400, {"error": "valid run and cursor required"})
                status, run = s.call("GET", "/api/heartbeat-runs/" + rid)
                if status != 200 or not isinstance(run, dict) or run.get("companyId") != company or run.get("agentId") != aid:
                    return self._send(404, {"error": "run not found for this member"})
                result = s.execution_run(run, before, company)
            return self._send(200, result)
        except ValueError:
            return self._send(400, {"error": "invalid cursor"})
        except Exception as exc:
            return self._send(500, {"error": str(exc)})

    def do_POST(self):
        url = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(body, dict):
                raise ValueError("JSON object required")
            if url.path not in ("/api/tasks", "/api/chat", "/api/send", "/api/model", "/api/member-config", "/api/issue-gate"):
                return self._send(404, {"error": "not found"})
            company = self._company(parse_qs(url.query), body)
            if not company:
                return self._send(404, {"error": "team not found"})
            if url.path == "/api/issue-gate":
                issue_id = body.get("issueId")
                action = body.get("action")
                if not isinstance(issue_id, str):
                    return self._send(400, {"ok": False, "error": "issueId required"})
                if action == "respond":
                    result = s.respond_interaction(company, issue_id, body.get("interactionId"), body.get("answers"))
                elif action == "resolve":
                    result = s.resolve_interaction(company, issue_id, body.get("interactionId"),
                                                   body.get("decision"), body.get("reason"),
                                                   body.get("selectedOptionIds"))
                elif action == "reply":
                    result = s.reply_issue(company, issue_id, body.get("text"), body.get("reopen") is True)
                else:
                    return self._send(400, {"ok": False, "error": "action must be respond, resolve or reply"})
                return self._send(200 if result.get("ok") else 400, result)
            if url.path == "/api/member-config":
                aid = body.get("agentId")
                if not isinstance(aid, str) or not aid.strip():
                    return self._send(400, {"ok": False, "error": "agentId required", "field": "agentId"})
                fields = {k: v for k, v in body.items() if k not in ("agentId", "company")}
                result = s.apply_member_patch(company, aid.strip(), fields)
                status = 200 if result.get("ok") else (result.get("httpStatus") or 400)
                public = {k: v for k, v in result.items() if k != "httpStatus"}
                return self._send(status, public)
            aid = body.get("agentId")
            field = {"/api/tasks": "title", "/api/model": "model"}.get(url.path, "text")
            value = body.get(field)
            if not isinstance(aid, str) or not isinstance(value, str) or not value.strip():
                return self._send(400, {"error": f"agentId and {field} required"})
            if url.path == "/api/tasks":
                result = s.create_task(company, aid, value, body.get("description") or "", body.get("priority") or "medium")
            elif url.path == "/api/chat":
                result = s.send_chat(company, aid, value.strip())
            elif url.path == "/api/send":
                result = s.send_message(aid, value.strip(), company)
            else:
                if not any(agent.get("id") == aid for agent in s.agents_for(company)):
                    return self._send(404, {"error": "agent not found for this team"})
                result = s.set_model(aid, value.strip(), company)
            return self._send(200, result)
        except (ValueError, TypeError):
            return self._send(400, {"error": "valid JSON object required"})
        except Exception as exc:
            return self._send(500, {"error": str(exc)})


def main():
    if not config.COMPANY:
        raise SystemExit("请设置 PAPERCLIP_COMPANY，配置方式见 README.md。")
    if not config.KEY_FILE.is_file() or not api_key():
        raise SystemExit("PAPERCLIP_KEY_FILE 必须指向非空的授权密钥文件。")
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"[room] http://{config.HOST}:{config.PORT} company={config.COMPANY}", flush=True)
    server.serve_forever()
