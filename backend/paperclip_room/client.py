"""Authenticated Paperclip REST transport. Credentials never reach the browser."""
import json
import urllib.error
import urllib.request

from .config import KEY_FILE, PAPERCLIP


def api_key():
    return KEY_FILE.read_text().strip()


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(PAPERCLIP + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + api_key())
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw.decode("utf-8", "replace")[:300]}
    except Exception as exc:
        return 599, {"error": str(exc)}
