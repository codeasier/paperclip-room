"""Process configuration; environment variables are loaded by the caller."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAPERCLIP = os.environ.get("PAPERCLIP_BASE", "http://127.0.0.1:3100").rstrip("/")
COMPANY = os.environ.get("PAPERCLIP_COMPANY", "").strip()
KEY_FILE = Path(os.environ.get("PAPERCLIP_KEY_FILE", Path.home() / ".paperclip/cli-automation.key")).expanduser()
HERMES_DB = Path(os.environ.get("HERMES_STATE_DB", Path.home() / ".hermes/state.db")).expanduser()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3200"))
STATIC_DIR = ROOT / "frontend" / "dist"
