from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import unittest
from unittest import mock

from api._external_grant import (
    grant_external_benefit,
    load_external_grant_config,
    resolve_external_benefit,
)


def encoded_profile(**overrides: object) -> str:
    profile: dict[str, object] = {
        "version": 1,
        "grant_url": "https://partner.invalid/grant",
        "plan_codes": ["PLAN-A"],
        "benefit_site": "partner",
        "benefit_plan_by_code": {"PLAN-A": "member"},
        "gift_benefit_site": "partner.invalid",
        "metadata_key": "partner_grant",
        "user_agent": "Vid2PPT-External-Grant/1.0",
    }
    profile.update(overrides)
    return base64.b64encode(
        json.dumps(profile, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")


class ExternalGrantTests(unittest.TestCase):
    def test_invalid_profiles_fail_closed(self) -> None:
        invalid_values = [
            "not-base64",
            encoded_profile(grant_url="http://partner.invalid/grant"),
            encoded_profile(benefit_plan_by_code={}),
        ]
        for encoded in invalid_values:
            with self.subTest(encoded=encoded[:20]):
                with mock.patch.dict(
                    os.environ,
                    {"VID2PPT_EXTERNAL_GRANT_CONFIG_B64": encoded},
                    clear=True,
                ):
                    self.assertIsNone(load_external_grant_config())

    def test_flag_and_plan_must_match(self) -> None:
        encoded = encoded_profile()
        with mock.patch.dict(
            os.environ,
            {"VID2PPT_EXTERNAL_GRANT_CONFIG_B64": encoded},
            clear=True,
        ):
            self.assertEqual((None, None), resolve_external_benefit("PLAN-A"))
        with mock.patch.dict(
            os.environ,
            {
                "VID2PPT_EXTERNAL_LINK_ENABLED": "true",
                "VID2PPT_EXTERNAL_GRANT_CONFIG_B64": encoded,
            },
            clear=True,
        ):
            self.assertEqual((None, None), resolve_external_benefit("PLAN-B"))
            config, plan = resolve_external_benefit("plan-a")
            self.assertIsNotNone(config)
            self.assertEqual("member", plan)

    def test_canonical_body_and_signature_are_preserved(self) -> None:
        secret = "test-shared-secret"
        encoded = encoded_profile()
        captured: dict[str, object] = {}

        class Response:
            status = 200

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"ok":true}'

        def fake_urlopen(request: object, timeout: int) -> Response:
            captured["request"] = request
            captured["timeout"] = timeout
            return Response()

        with mock.patch.dict(
            os.environ,
            {
                "VID2PPT_EXTERNAL_LINK_ENABLED": "true",
                "VID2PPT_EXTERNAL_GRANT_CONFIG_B64": encoded,
                "VID2PPT_EXTERNAL_GRANT_SECRET": secret,
            },
            clear=True,
        ):
            config, _ = resolve_external_benefit("PLAN-A")
            self.assertIsNotNone(config)
            with mock.patch("api._external_grant.urllib.request.urlopen", fake_urlopen):
                result = grant_external_benefit(
                    config=config,
                    email="user@example.com",
                    plan_code="PLAN-A",
                    request_id="request-123",
                    transaction_id="transaction-456",
                    event_id="event-789",
                    completed_at="2026-08-02T12:00:00+00:00",
                    amount_cny="10.00",
                    quantity=1000,
                )

        request = captured["request"]
        expected_payload = {
            "email": "user@example.com",
            "plan_code": "PLAN-A",
            "request_id": "request-123",
            "paddle_transaction_id": "transaction-456",
            "event_id": "event-789",
            "completed_at": "2026-08-02T12:00:00+00:00",
            "amount_cny": "10.00",
            "quantity": 1000,
            "legal_purchase_site": "vid2ppt.com",
            "gift_benefit_site": "partner.invalid",
        }
        expected_body = json.dumps(
            expected_payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        expected_signature = hmac.new(
            secret.encode("utf-8"),
            expected_body,
            hashlib.sha256,
        ).hexdigest()

        self.assertEqual(expected_body, request.data)
        self.assertEqual(
            f"sha256={expected_signature}",
            request.get_header("X-vid2ppt-signature"),
        )
        self.assertEqual(12, captured["timeout"])
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
