from __future__ import annotations

import io
import json
import os
import unittest
from unittest.mock import Mock, patch

import httpx

from api import _contact
from server_handlers import usage


VALID_FORM = {
    "name": "测试访客",
    "email": "visitor@example.com",
    "subject": "视频转幻灯片问题",
    "message": "您好，我想了解如何导出可编辑的幻灯片。",
    "website": "",
    "request_id": "cf15e445-a91c-45f8-a367-1047dc79e05b",
    "turnstile_token": "test-only-turnstile-token",
}
TEST_ENV = {
    "CONTACT_EMAIL_PROVIDER": "brevo",
    "BREVO_API_KEY": "test-only-api-key",
    "CONTACT_FROM_EMAIL": "info@vid2ppt.com",
    "CONTACT_TO_EMAIL": "private-recipient@example.com",
    "CONTACT_ALLOWED_ORIGINS": "",
}


def request_handler(data: object = VALID_FORM, *, headers: dict[str, str] | None = None, body: bytes | None = None) -> object:
    instance = object.__new__(usage.handler)
    instance.path = "/api/usage?action=contact"
    content = json.dumps(data, ensure_ascii=False).encode("utf-8") if body is None else body
    instance.headers = {
        "origin": "https://vid2ppt.com",
        "content-type": "application/json",
        "content-length": str(len(content)),
        **(headers or {}),
    }
    instance.rfile = io.BytesIO(content)
    instance.wfile = io.BytesIO()
    instance.send_response = Mock()
    instance.send_header = Mock()
    instance.end_headers = Mock()
    return instance


def response_body(request: object) -> dict:
    return json.loads(request.wfile.getvalue())


class ContactApiTests(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, TEST_ENV)
        environment.start()
        self.addCleanup(environment.stop)
        self.audit = patch.object(_contact, "audit_event").start()
        patch.object(_contact, "verify_turnstile").start()
        self.addCleanup(patch.stopall)

    def test_success_sends_fixed_recipient_and_customer_reply_to(self) -> None:
        request = request_handler({**VALID_FORM, "to": "attacker@example.com", "email": "visitor@EXAMPLE.COM"})
        with patch.object(_contact.httpx, "post", return_value=httpx.Response(201, json={"messageId": "<provider-message-id>"})) as post:
            request.do_POST()
        request.send_response.assert_called_once_with(200)
        response = response_body(request)
        self.assertTrue(response["success"])
        self.assertRegex(response["reference"], r"^V2P-[A-F0-9]{20}$")
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["to"], [{"email": TEST_ENV["CONTACT_TO_EMAIL"]}])
        self.assertEqual(sent["replyTo"], {"name": VALID_FORM["name"], "email": "visitor@example.com"})
        self.assertIn(VALID_FORM["message"], sent["textContent"])
        self.audit.assert_called_once_with("contact.accepted", response["reference"], provider_message_id="<provider-message-id>")
        self.assertNotIn(TEST_ENV["CONTACT_TO_EMAIL"], request.wfile.getvalue().decode())
        self.assertNotIn(TEST_ENV["BREVO_API_KEY"], request.wfile.getvalue().decode())

    def test_contact_route_delegates_before_usage_reads_body_or_authenticates(self) -> None:
        request = request_handler()
        request.read_json = Mock(side_effect=AssertionError("Usage must not read the contact body"))
        request.handle_record_usage = Mock(side_effect=AssertionError("Contact must remain available to visitors"))
        with patch.object(usage, "handle_contact_post") as delegate:
            request.do_POST()
        delegate.assert_called_once_with(request)
        request.read_json.assert_not_called()
        request.handle_record_usage.assert_not_called()

    def test_other_usage_action_keeps_original_body_dispatch(self) -> None:
        request = request_handler()
        request.path = "/api/usage?action=site_event"
        request.read_json = Mock(return_value={"event_type": "contact.viewed"})
        request.handle_site_event = Mock()
        with patch.object(usage, "handle_contact_post") as delegate:
            request.do_POST()
        delegate.assert_not_called()
        request.handle_site_event.assert_called_once_with({"event_type": "contact.viewed"})

    def test_contact_get_returns_method_guidance_without_requiring_login(self) -> None:
        request = request_handler()
        with patch.object(usage, "authenticated_email") as authenticate:
            request.do_GET()
        authenticate.assert_not_called()
        request.send_response.assert_called_once_with(405)

    def test_honeypot_rejects_without_claiming_email_sent(self) -> None:
        request = request_handler({**VALID_FORM, "website": "https://spam.example"})
        with patch.object(_contact.httpx, "post") as post:
            request.do_POST()
        post.assert_not_called()
        request.send_response.assert_called_once_with(400)
        self.assertNotIn("success", response_body(request))

    def test_rejects_cross_site_origin_before_reading_body(self) -> None:
        request = request_handler(headers={"origin": "https://attacker.example"})
        with patch.object(_contact.httpx, "post") as post:
            request.do_POST()
        request.send_response.assert_called_once_with(403)
        self.assertEqual(request.rfile.tell(), 0)
        post.assert_not_called()
        self.assertFalse(any(call.args[0] == "Access-Control-Allow-Origin" for call in request.send_header.call_args_list))

    def test_rejects_oversize_before_reading_body(self) -> None:
        request = request_handler(headers={"content-length": str(_contact.MAX_BODY_BYTES + 1)})
        with patch.object(_contact.httpx, "post") as post:
            request.do_POST()
        request.send_response.assert_called_once_with(413)
        self.assertEqual(request.rfile.tell(), 0)
        post.assert_not_called()

    def test_rejects_malformed_requests(self) -> None:
        cases = [
            ({"content-type": "text/plain"}, b"{}", 415),
            ({"content-length": "invalid"}, b"{}", 400),
            ({"content-length": "-1"}, b"{}", 400),
            ({"content-length": "200"}, b"{}", 400),
            ({}, b"not-json", 400),
            ({}, b"\xff", 400),
            ({}, b"[]", 400),
            ({"transfer-encoding": "chunked"}, b"{}", 400),
        ]
        for headers, body, status in cases:
            with self.subTest(headers=headers, body=body):
                request = request_handler(headers=headers, body=body)
                with patch.object(_contact.httpx, "post") as post:
                    request.do_POST()
                request.send_response.assert_called_once_with(status)
                post.assert_not_called()

    def test_rejects_invalid_fields_and_header_injection(self) -> None:
        cases = [
            {"name": "Alice\r\nBcc: attacker@example.com"},
            {"subject": "Subject\nInjected: yes"},
            {"email": "visitor@example.com\n"},
            {"email": "a@example.com,b@example.com"},
            {"email": "a..b@example.com"},
            {"email": "a@-invalid.example"},
            {"message": "short"},
            {"message": "a" * 5001},
            {"message": "Message\x00with control"},
            {"name": "a" * 101},
            {"name": []},
            {"subject": None},
            {"request_id": "bad-reference"},
            {"request_id": 1},
        ]
        for change in cases:
            with self.subTest(change=change):
                request = request_handler({**VALID_FORM, **change})
                with patch.object(_contact.httpx, "post") as post:
                    request.do_POST()
                request.send_response.assert_called_once_with(400)
                post.assert_not_called()

    def test_configuration_missing_is_503_and_never_fake_success(self) -> None:
        request = request_handler()
        with patch.dict(os.environ, {"BREVO_API_KEY": ""}), patch.object(_contact.httpx, "post") as post:
            request.do_POST()
        post.assert_not_called()
        request.send_response.assert_called_once_with(503)
        self.assertNotIn("success", response_body(request))
        self.assertEqual(response_body(request)["detail"], "联系表单暂时无法使用，请直接发送邮件至 info@vid2ppt.com。")

    def test_provider_rejection_is_redacted_and_retryable(self) -> None:
        for status, expected in [(400, 502), (401, 503), (403, 503), (429, 503), (500, 502)]:
            with self.subTest(status=status):
                request = request_handler()
                upstream = httpx.Response(status, json={"code": "invalid_parameter", "message": TEST_ENV["BREVO_API_KEY"] + TEST_ENV["CONTACT_TO_EMAIL"]})
                with patch.object(_contact.httpx, "post", return_value=upstream):
                    request.do_POST()
                request.send_response.assert_called_once_with(expected)
                self.assertNotIn(TEST_ENV["BREVO_API_KEY"], request.wfile.getvalue().decode())
                self.assertNotIn(TEST_ENV["CONTACT_TO_EMAIL"], request.wfile.getvalue().decode())

    def test_provider_timeout_does_not_claim_success(self) -> None:
        request = request_handler()
        with patch.object(_contact.httpx, "post", side_effect=httpx.ReadTimeout("internal secret detail")):
            request.do_POST()
        request.send_response.assert_called_once_with(502)
        self.assertNotIn("internal secret", request.wfile.getvalue().decode())
        self.assertEqual(response_body(request)["detail"], "暂时无法确认留言是否已发送，请稍后重试，或直接发送邮件至 info@vid2ppt.com。")

    def test_success_requires_real_provider_message_id(self) -> None:
        for result in [{}, {"messageId": ""}, {"messageId": 42}, []]:
            with self.subTest(result=result):
                request = request_handler()
                with patch.object(_contact.httpx, "post", return_value=httpx.Response(201, json=result)):
                    request.do_POST()
                request.send_response.assert_called_once_with(502)
                self.assertNotIn("success", response_body(request))

    def test_retry_reuses_reference_and_provider_idempotency_key(self) -> None:
        requests = [request_handler(), request_handler()]
        with patch.object(_contact.httpx, "post", side_effect=[
            httpx.Response(201, json={"messageId": "<first-message>"}),
            httpx.Response(400, json={"code": "duplicate_parameter"}),
        ]) as post:
            for request in requests:
                request.do_POST()
        self.assertEqual(response_body(requests[0]), response_body(requests[1]))
        keys = [call.kwargs["headers"]["idempotencyKey"] for call in post.call_args_list]
        self.assertEqual(keys[0], keys[1])
        self.assertTrue(response_body(requests[1])["success"])

    def test_same_client_id_with_changed_content_does_not_suppress_message(self) -> None:
        with patch.object(_contact.httpx, "post", return_value=httpx.Response(201, json={"messageId": "<provider-message>"})) as post:
            request_handler().do_POST()
            request_handler({**VALID_FORM, "message": "This is a different, valid inquiry."}).do_POST()
        first, second = [call.kwargs["headers"]["idempotencyKey"] for call in post.call_args_list]
        self.assertNotEqual(first, second)

    def test_allowed_origin_response_and_preflight_are_restricted(self) -> None:
        request = request_handler()
        request.do_OPTIONS()
        request.send_response.assert_called_once_with(204)
        request.send_header.assert_any_call("Access-Control-Allow-Origin", "https://vid2ppt.com")
        request.send_header.assert_any_call("Access-Control-Allow-Methods", "POST, OPTIONS")
        request.send_header.assert_any_call("Cache-Control", "no-store")
        with patch.dict(os.environ, {"CONTACT_ALLOWED_ORIGINS": "*,https://preview.example"}):
            self.assertNotIn("*", _contact.allowed_origins())
            self.assertIn("https://preview.example", _contact.allowed_origins())


class CloudflareContactTests(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, {
            **TEST_ENV,
            "CONTACT_EMAIL_PROVIDER": "cloudflare",
            "CLOUDFLARE_EMAIL_API_TOKEN": "test-only-cloudflare-token",
            "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.audit = patch.object(_contact, "audit_event").start()
        patch.object(_contact, "verify_turnstile").start()
        self.addCleanup(patch.stopall)

    def test_cloudflare_delivered_and_queued_confirm_fixed_recipient(self) -> None:
        for delivery_status in ["delivered", "queued"]:
            with self.subTest(delivery_status=delivery_status):
                self.audit.reset_mock()
                request = request_handler({**VALID_FORM, "to": "attacker@example.com"})
                result = {delivery_status: [TEST_ENV["CONTACT_TO_EMAIL"]], "message_id": "<cf-message>"}
                with patch.object(_contact.httpx, "post", return_value=httpx.Response(200, json={"success": True, "result": result})) as post:
                    request.do_POST()
                request.send_response.assert_called_once_with(200)
                payload = post.call_args.kwargs["json"]
                self.assertEqual(post.call_args.args[0], f"https://api.cloudflare.com/client/v4/accounts/{'a' * 32}/email/sending/send")
                self.assertEqual(payload["to"], TEST_ENV["CONTACT_TO_EMAIL"])
                self.assertEqual(payload["from"]["address"], TEST_ENV["CONTACT_FROM_EMAIL"])
                self.assertEqual(payload["reply_to"], {"address": VALID_FORM["email"], "name": VALID_FORM["name"]})
                self.assertIn(VALID_FORM["message"], payload["text"])
                reference = response_body(request)["reference"]
                self.audit.assert_called_once_with("contact.accepted", reference, provider="cloudflare", delivery_status=delivery_status, provider_message_id="<cf-message>")
                self.assertNotIn(TEST_ENV["CONTACT_TO_EMAIL"], request.wfile.getvalue().decode())

    def test_cloudflare_does_not_require_message_id_in_older_rest_response(self) -> None:
        request = request_handler()
        with patch.object(_contact.httpx, "post", return_value=httpx.Response(200, json={
            "success": True, "result": {"queued": [TEST_ENV["CONTACT_TO_EMAIL"]]},
        })):
            request.do_POST()
        request.send_response.assert_called_once_with(200)
        self.assertTrue(response_body(request)["success"])

    def test_cloudflare_never_confuses_bounce_suppression_or_other_recipient_for_success(self) -> None:
        recipient = TEST_ENV["CONTACT_TO_EMAIL"]
        results = [
            {"delivered": ["other@example.com"]},
            {"permanent_bounces": [recipient]},
            {"suppressed_recipients": [recipient]},
            {"delivered": [recipient], "permanent_bounces": [recipient]},
            {"queued": [recipient], "suppressed_recipients": [recipient]},
            {"delivered": recipient},
            {},
        ]
        for result in results:
            with self.subTest(result=result):
                request = request_handler()
                with patch.object(_contact.httpx, "post", return_value=httpx.Response(200, json={"success": True, "result": result})):
                    request.do_POST()
                request.send_response.assert_called_once_with(502)
                self.assertNotIn("success", response_body(request))

    def test_cloudflare_errors_are_redacted(self) -> None:
        for status in [400, 401, 403, 429, 500]:
            with self.subTest(status=status):
                request = request_handler()
                with patch.object(_contact.httpx, "post", return_value=httpx.Response(status, json={
                    "success": False, "errors": [{"message": "test-only-cloudflare-token" + TEST_ENV["CONTACT_TO_EMAIL"]}],
                })):
                    request.do_POST()
                request.send_response.assert_called_once_with(503 if status in {401, 403, 429} else 502)
                self.assertNotIn("test-only-cloudflare-token", request.wfile.getvalue().decode())
                self.assertNotIn(TEST_ENV["CONTACT_TO_EMAIL"], request.wfile.getvalue().decode())

    def test_cloudflare_missing_token_or_account_fails_before_provider(self) -> None:
        for missing in ["CLOUDFLARE_EMAIL_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]:
            with self.subTest(missing=missing), patch.dict(os.environ, {missing: ""}):
                request = request_handler()
                with patch.object(_contact.httpx, "post") as post:
                    request.do_POST()
                post.assert_not_called()
                request.send_response.assert_called_once_with(503)


class TurnstileContactTests(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, {**TEST_ENV, "CONTACT_TURNSTILE_SECRET_KEY": "test-only-turnstile-secret"})
        environment.start()
        self.addCleanup(environment.stop)

    def test_verification_must_pass_before_sending_email(self) -> None:
        request = request_handler()
        with patch.object(_contact.httpx, "post", return_value=httpx.Response(200, json={
            "success": True, "hostname": "vid2ppt.com", "action": "contact",
        })) as post, patch.object(_contact, "send_contact_message", return_value={"success": True, "reference": "test"}) as send:
            request.do_POST()
        post.assert_called_once()
        self.assertEqual(post.call_args.args[0], _contact.TURNSTILE_VERIFY_URL)
        self.assertEqual(post.call_args.kwargs["json"], {"secret": "test-only-turnstile-secret", "response": VALID_FORM["turnstile_token"]})
        send.assert_called_once()
        request.send_response.assert_called_once_with(200)

    def test_wrong_hostname_action_or_expired_token_never_sends(self) -> None:
        cases = [
            ({"success": True, "hostname": "attacker.example", "action": "contact"}, 403),
            ({"success": True, "hostname": "vid2ppt.com", "action": "login"}, 403),
            ({"success": True, "hostname": "vid2ppt.com"}, 403),
            ({"success": False, "error-codes": ["timeout-or-duplicate"]}, 400),
            ({"success": "true", "hostname": "vid2ppt.com", "action": "contact"}, 400),
        ]
        for result, status in cases:
            with self.subTest(result=result):
                request = request_handler()
                with patch.object(_contact.httpx, "post", return_value=httpx.Response(200, json=result)), patch.object(_contact, "send_contact_message") as send:
                    request.do_POST()
                send.assert_not_called()
                request.send_response.assert_called_once_with(status)

    def test_missing_or_oversize_token_and_missing_secret_fail_closed(self) -> None:
        for token in [None, "", "a" * 2049, [], "bad\ntoken"]:
            with self.subTest(token=token):
                request = request_handler({**VALID_FORM, "turnstile_token": token})
                with patch.object(_contact.httpx, "post") as post, patch.object(_contact, "send_contact_message") as send:
                    request.do_POST()
                post.assert_not_called()
                send.assert_not_called()
                request.send_response.assert_called_once_with(400)
        request = request_handler()
        with patch.dict(os.environ, {"CONTACT_TURNSTILE_SECRET_KEY": ""}), patch.object(_contact.httpx, "post") as post:
            request.do_POST()
        post.assert_not_called()
        request.send_response.assert_called_once_with(503)

    def test_siteverify_network_or_malformed_response_never_sends(self) -> None:
        for response in [httpx.Response(500, json={"success": False}), httpx.Response(200, text="not-json"), httpx.Response(200, json=[])]:
            request = request_handler()
            with patch.object(_contact.httpx, "post", return_value=response), patch.object(_contact, "send_contact_message") as send:
                request.do_POST()
            send.assert_not_called()
            self.assertGreaterEqual(request.send_response.call_args.args[0], 400)
        request = request_handler()
        with patch.object(_contact.httpx, "post", side_effect=httpx.ReadTimeout("private-secret")), patch.object(_contact, "send_contact_message") as send:
            request.do_POST()
        send.assert_not_called()
        request.send_response.assert_called_once_with(503)
        self.assertNotIn("private-secret", request.wfile.getvalue().decode())

    def test_optional_name_is_accepted(self) -> None:
        form = {key: value for key, value in VALID_FORM.items() if key != "name"}
        result = _contact.validate_contact(form)
        self.assertEqual(result["name"], "")

    def test_field_errors_use_readable_chinese_names(self) -> None:
        cases = [
            ({"subject": ""}, "请填写留言主题。"),
            ({"email": "not-an-email"}, "请填写有效的邮箱地址，方便我们回复。"),
            ({"message": "太短"}, "留言内容至少需要 10 个字符，请补充后提交。"),
            ({"name": "称" * 101}, "称呼请控制在 100 个字符以内。"),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields), self.assertRaises(_contact.ContactError) as caught:
                _contact.validate_contact({**VALID_FORM, **fields})
            self.assertEqual(caught.exception.detail, expected)


if __name__ == "__main__":
    unittest.main()
