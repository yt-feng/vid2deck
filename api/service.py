from __future__ import annotations

from functools import lru_cache
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
from pathlib import Path
import urllib.parse


HANDLER_FILES = {
    "auth": "auth.py",
    "captcha": "captcha.py",
    "entitlement": "entitlement.py",
    "login": "login.py",
    "paddle-config": "paddle-config.py",
    "paddle-webhook": "paddle-webhook.py",
    "summarize": "summarize.py",
    "summarize-simple": "summarize-simple.py",
    "usage": "usage.py",
}
ALIASES = {"contact": "contact", "redeem-code": "redeem_code"}
METHODS = ("GET", "POST", "OPTIONS")
HANDLERS_DIRECTORY = Path(__file__).resolve().parents[1] / "server_handlers"


def resolve_request(raw_path: str) -> tuple[str, str] | None:
    parsed = urllib.parse.urlsplit(raw_path)
    params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if parsed.path == "/api/service":
        routes = [value for key, value in params if key == "__route"]
        if len(routes) != 1:
            return None
        route = routes[0]
    elif parsed.path.startswith("/api/"):
        route = parsed.path[len("/api/"):]
    else:
        return None

    params = [(key, value) for key, value in params if key != "__route"]
    if route in ALIASES:
        params = [(key, value) for key, value in params if key != "action"]
        params.append(("action", ALIASES[route]))
        route = "usage"
    if route not in HANDLER_FILES:
        return None
    path = urllib.parse.urlunsplit(("", "", f"/api/{route}", urllib.parse.urlencode(params), ""))
    return route, path


@lru_cache(maxsize=len(HANDLER_FILES))
def load_handler(route: str) -> type[BaseHTTPRequestHandler]:
    filename = HANDLER_FILES.get(route)
    if filename is None:
        raise ValueError("Unknown service route")
    module_name = "vid2ppt_service_" + route.replace("-", "_")
    spec = importlib.util.spec_from_file_location(module_name, HANDLERS_DIRECTORY / filename)
    if spec is None or spec.loader is None:
        raise ImportError("Service handler is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.handler


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_OPTIONS(self) -> None:
        self.dispatch("OPTIONS")

    def unsupported_method(self) -> None:
        self.dispatch("")

    do_HEAD = unsupported_method
    do_PUT = unsupported_method
    do_PATCH = unsupported_method
    do_DELETE = unsupported_method
    do_TRACE = unsupported_method
    do_CONNECT = unsupported_method

    def dispatch(self, method: str) -> None:
        resolved = resolve_request(self.path)
        if resolved is None:
            self.send_service_error(404, "Unknown API route")
            return
        route, forwarded_path = resolved
        original_class = load_handler(route)
        allowed = [name for name in METHODS if callable(getattr(original_class, f"do_{name}", None))]
        if method not in allowed:
            self.send_service_error(405, "Method not allowed", allow=", ".join(allowed))
            return

        # Reuse the parsed request and response state without reopening its socket.
        original = original_class.__new__(original_class)
        original.__dict__ = self.__dict__
        original.path = forwarded_path
        getattr(original, f"do_{method}")()

    def send_service_error(self, status: int, detail: str, *, allow: str | None = None) -> None:
        body = json.dumps({"detail": detail}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if allow is not None:
            self.send_header("Allow", allow)
        self.end_headers()
        if getattr(self, "command", "") != "HEAD":
            self.wfile.write(body)
