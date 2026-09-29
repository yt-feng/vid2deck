from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.parse

from api import service


class RecordingBody(io.BytesIO):
    def __init__(self, body: bytes):
        super().__init__(body)
        self.read_count = 0

    def read(self, *args, **kwargs):
        self.read_count += 1
        return super().read(*args, **kwargs)


class OriginalHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        raise AssertionError("The router must not initialize another socket handler")

    def original_helper(self) -> str:
        return "original helper"

    def do_GET(self) -> None:
        self.helper_result = self.original_helper()
        self.request_headers_seen = self.headers
        self.send_header("X-Original-Handler", "yes")
        self.pending_headers = list(self._headers_buffer)
        self.end_headers()
        self.wfile.write(b"original response")
        self.close_connection = True

    def do_POST(self) -> None:
        self.body_seen = self.rfile.read(int(self.headers["Content-Length"]))
        self.path_seen = self.path
        self.wfile.write(self.body_seen)

    def do_OPTIONS(self) -> None:
        self.options_seen = True


class ReadOnlyHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.wfile.write(b"ok")


def request_handler(path: str, *, body: bytes = b"", method: str = "GET"):
    request = object.__new__(service.handler)
    request.path = path
    request.command = method
    request.request_version = "HTTP/1.1"
    request.headers = {"Content-Length": str(len(body)), "X-Test": "request header"}
    request.rfile = RecordingBody(body)
    request.wfile = io.BytesIO()
    request._headers_buffer = []
    request.send_response = Mock()
    request.close_connection = False
    return request


class ServiceRouterTests(unittest.TestCase):
    def test_original_class_helpers_and_request_response_state_are_preserved(self) -> None:
        request = request_handler("/api/auth")
        original_state = request.__dict__
        request_headers = request.headers
        response_stream = request.wfile
        with patch.object(service, "load_handler", return_value=OriginalHandler):
            request.do_GET()
        self.assertIs(request.__dict__, original_state)
        self.assertIs(request.request_headers_seen, request_headers)
        self.assertIs(request.wfile, response_stream)
        self.assertEqual(request.helper_result, "original helper")
        self.assertEqual(request.pending_headers, [b"X-Original-Handler: yes\r\n"])
        self.assertEqual(request.wfile.getvalue(), b"X-Original-Handler: yes\r\n\r\noriginal response")
        self.assertTrue(request.close_connection)
        self.assertEqual(request.rfile.read_count, 0)

    def test_all_nine_original_routes_dispatch_to_their_whitelisted_handler(self) -> None:
        self.assertEqual(len(service.HANDLER_FILES), 9)
        for route in service.HANDLER_FILES:
            with self.subTest(route=route):
                request = request_handler(f"/api/{route}")
                with patch.object(service, "load_handler", return_value=OriginalHandler) as load:
                    request.do_OPTIONS()
                load.assert_called_once_with(route)
                self.assertTrue(request.options_seen)

    def test_rewritten_route_reads_original_body_once_and_preserves_query_values(self) -> None:
        body = b'{ "raw": "unchanged", "action": "body_action" }'
        request = request_handler(
            "/api/service?__route=paddle-webhook&tag=first&tag=second&empty=&q=a%2Bb",
            body=body,
            method="POST",
        )
        original_stream = request.rfile
        with patch.object(service, "load_handler", return_value=OriginalHandler) as load:
            request.do_POST()
        load.assert_called_once_with("paddle-webhook")
        self.assertIs(request.rfile, original_stream)
        self.assertEqual(request.rfile.read_count, 1)
        self.assertEqual(request.body_seen, body)
        self.assertEqual(request.wfile.getvalue(), body)
        parsed = urllib.parse.urlsplit(request.path_seen)
        self.assertEqual(parsed.path, "/api/paddle-webhook")
        self.assertEqual(
            urllib.parse.parse_qsl(parsed.query, keep_blank_values=True),
            [("tag", "first"), ("tag", "second"), ("empty", ""), ("q", "a+b")],
        )

    def test_internal_route_cannot_override_an_original_api_path(self) -> None:
        request = request_handler("/api/auth?__route=usage&keep=value")
        with patch.object(service, "load_handler", return_value=OriginalHandler) as load:
            request.do_OPTIONS()
        load.assert_called_once_with("auth")
        self.assertEqual(request.path, "/api/auth?keep=value")

    def test_contact_and_redeem_aliases_force_query_action_without_changing_body(self) -> None:
        body = b'{"action":"keep_existing_body_precedence","code":"test-only"}'
        for alias, action in (("contact", "contact"), ("redeem-code", "redeem_code")):
            for base in (f"/api/{alias}?", f"/api/service?__route={alias}&"):
                with self.subTest(alias=alias, base=base):
                    request = request_handler(base + "action=wrong&keep=yes&action=second", body=body, method="POST")
                    with patch.object(service, "load_handler", return_value=OriginalHandler) as load:
                        request.do_POST()
                    load.assert_called_once_with("usage")
                    self.assertEqual(request.path_seen, f"/api/usage?keep=yes&action={action}")
                    self.assertEqual(request.body_seen, body)
                    self.assertEqual(request.rfile.read_count, 1)

    def test_unknown_ambiguous_and_traversal_routes_return_404_without_loading(self) -> None:
        for path in (
            "/api/missing",
            "/api/missing?__route=auth",
            "/outside?__route=auth",
            "/api/service",
            "/api/service?__route=auth&__route=usage",
            "/api/service?__route=../auth",
            "/api/service?__route=auth.py",
            "/api/../server_handlers/auth",
        ):
            with self.subTest(path=path):
                request = request_handler(path)
                with patch.object(service, "load_handler") as load:
                    request.do_GET()
                load.assert_not_called()
                request.send_response.assert_called_once_with(404)
                self.assertEqual(request.rfile.read_count, 0)
                self.assertIn(b'"detail": "Unknown API route"', request.wfile.getvalue())

    def test_missing_original_method_returns_405_without_reading_body(self) -> None:
        request = request_handler("/api/paddle-config", body=b"untouched", method="POST")
        with patch.object(service, "load_handler", return_value=ReadOnlyHandler):
            request.do_POST()
        request.send_response.assert_called_once_with(405)
        self.assertIn(b"Allow: GET\r\n", request.wfile.getvalue())
        self.assertEqual(request.rfile.read_count, 0)

    def test_other_http_methods_return_405_and_head_has_no_response_body(self) -> None:
        for method in ("DELETE", "PUT", "PATCH", "HEAD", "TRACE", "CONNECT"):
            with self.subTest(method=method):
                request = request_handler("/api/auth", body=b"untouched", method=method)
                with patch.object(service, "load_handler", return_value=OriginalHandler):
                    getattr(request, f"do_{method}")()
                request.send_response.assert_called_once_with(405)
                self.assertIn(b"Allow: GET, POST, OPTIONS\r\n", request.wfile.getvalue())
                response_body = request.wfile.getvalue().split(b"\r\n\r\n", 1)[1]
                if method == "HEAD":
                    self.assertEqual(response_body, b"")
                else:
                    self.assertEqual(json.loads(response_body), {"detail": "Method not allowed"})
                self.assertEqual(request.rfile.read_count, 0)

    def test_loader_maps_hyphenated_filename_and_caches_handler(self) -> None:
        service.load_handler.cache_clear()
        self.addCleanup(service.load_handler.cache_clear)
        loader = Mock()
        spec = SimpleNamespace(loader=loader)
        module = SimpleNamespace(handler=OriginalHandler)
        with patch.object(service.importlib.util, "spec_from_file_location", return_value=spec) as from_file:
            with patch.object(service.importlib.util, "module_from_spec", return_value=module):
                self.assertIs(service.load_handler("paddle-webhook"), OriginalHandler)
                self.assertIs(service.load_handler("paddle-webhook"), OriginalHandler)
        from_file.assert_called_once_with(
            "vid2ppt_service_paddle_webhook", service.HANDLERS_DIRECTORY / "paddle-webhook.py"
        )
        loader.exec_module.assert_called_once_with(module)

    def test_loader_rejects_non_whitelisted_filenames_before_import(self) -> None:
        with patch.object(service.importlib.util, "spec_from_file_location") as from_file:
            with self.assertRaises(ValueError):
                service.load_handler("../../arbitrary")
        from_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
