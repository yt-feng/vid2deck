from __future__ import annotations

import os
import unittest
import urllib.parse
from unittest.mock import Mock, patch

from api import _auth, _plans
from server_handlers import auth, entitlement, usage


TEST_AUTH_SECRET = "test-only-auth-secret"


def user_token(email: str = "alice@example.com", username: str = "alice") -> str:
    return _auth.create_user_token(
        {
            "id": f"user-{username}",
            "username": username,
            "email": email,
        }
    )


def request_handler(module: object, *, path: str = "/", token: str = "") -> object:
    instance = object.__new__(module.handler)
    instance.path = path
    instance.headers = {"authorization": f"Bearer {token}" if token else ""}
    instance.send_json = Mock()
    return instance


class ApiAuthorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, {"AUTH_SECRET": TEST_AUTH_SECRET})
        environment.start()
        self.addCleanup(environment.stop)

    def test_usage_get_derives_email_from_user_token(self) -> None:
        token = user_token("Alice@Example.com")
        request = request_handler(usage, path="/api/usage", token=token)
        payload = {"email": "alice@example.com", "monthly": {}}

        with patch.object(usage, "usage_payload", return_value=payload) as load_usage:
            request.do_GET()

        load_usage.assert_called_once_with("alice@example.com")
        request.send_json.assert_called_once_with(payload)

    def test_usage_get_rejects_email_from_another_account(self) -> None:
        token = user_token("alice@example.com")
        requested = urllib.parse.quote("bob@example.com")
        request = request_handler(usage, path=f"/api/usage?email={requested}", token=token)

        with patch.object(usage, "usage_payload") as load_usage:
            request.do_GET()

        load_usage.assert_not_called()
        request.send_json.assert_called_once_with(
            {"detail": "Email does not match authenticated user"},
            403,
        )

    def test_usage_get_requires_user_token(self) -> None:
        request = request_handler(usage, path="/api/usage?email=alice%40example.com")

        with patch.object(usage, "usage_payload") as load_usage:
            request.do_GET()

        load_usage.assert_not_called()
        request.send_json.assert_called_once_with({"detail": "User login required"}, 401)

    def test_usage_post_records_only_the_token_email(self) -> None:
        token = user_token("alice@example.com")
        request = request_handler(usage, token=token)
        payload = {"email": "alice@example.com", "monthly": {"video_conversion": 2}}

        with (
            patch.object(usage, "insert_usage_event") as insert_event,
            patch.object(usage, "usage_payload", return_value=payload),
        ):
            request.handle_record_usage(
                {
                    "event_type": "video_conversion",
                    "units": 2,
                    "metadata": {"source": "test"},
                }
            )

        insert_event.assert_called_once_with(
            "alice@example.com",
            "video_conversion",
            {"source": "test"},
            units=2,
        )
        request.send_json.assert_called_once_with(payload, 201)

    def test_usage_post_rejects_cross_account_write(self) -> None:
        token = user_token("alice@example.com")
        request = request_handler(usage, token=token)

        with patch.object(usage, "insert_usage_event") as insert_event:
            request.handle_record_usage(
                {
                    "email": "bob@example.com",
                    "event_type": "video_conversion",
                    "units": 1,
                }
            )

        insert_event.assert_not_called()
        request.send_json.assert_called_once_with(
            {"detail": "Email does not match authenticated user"},
            403,
        )

    def test_usage_post_requires_token_before_parsing_usage_fields(self) -> None:
        request = request_handler(usage)

        with patch.object(usage, "insert_usage_event") as insert_event:
            request.handle_record_usage(
                {
                    "email": "alice@example.com",
                    "event_type": "video_conversion",
                    "units": "not-an-integer",
                }
            )

        insert_event.assert_not_called()
        request.send_json.assert_called_once_with({"detail": "User login required"}, 401)

    def test_sponsor_code_status_remains_available_without_user_token(self) -> None:
        request = request_handler(
            usage,
            path="/api/usage?action=sponsor_code&request_id=checkout_123",
        )

        with patch.object(usage, "find_sponsor_order_by_request_id", return_value=None) as find_order:
            request.do_GET()

        find_order.assert_called_once_with("checkout_123")
        request.send_json.assert_called_once_with({"ok": True, "status": "pending", "code": None})

    def test_entitlement_derives_email_from_user_token(self) -> None:
        token = user_token("Alice@Example.com")
        request = request_handler(entitlement, path="/api/entitlement", token=token)

        with patch.object(entitlement, "find_entitlement", return_value=None) as find_entitlement:
            request.do_GET()

        find_entitlement.assert_called_once_with("alice@example.com")
        request.send_json.assert_called_once_with(entitlement.free_payload("alice@example.com"))

    def test_entitlement_rejects_cross_account_query(self) -> None:
        token = user_token("alice@example.com")
        request = request_handler(
            entitlement,
            path="/api/entitlement?email=bob%40example.com",
            token=token,
        )

        with patch.object(entitlement, "find_entitlement") as find_entitlement:
            request.do_GET()

        find_entitlement.assert_not_called()
        request.send_json.assert_called_once_with(
            {"detail": "Email does not match authenticated user"},
            403,
        )

    def test_entitlement_requires_user_token(self) -> None:
        request = request_handler(
            entitlement,
            path="/api/entitlement?email=alice%40example.com",
        )

        with patch.object(entitlement, "find_entitlement") as find_entitlement:
            request.do_GET()

        find_entitlement.assert_not_called()
        request.send_json.assert_called_once_with({"detail": "User login required"}, 401)

    def test_former_default_owner_username_has_only_normal_entitlement(self) -> None:
        token = user_token(
            "twotigers_vid@users.vid2ppt.com",
            username="twotigers_vid",
        )
        request = request_handler(entitlement, path="/api/entitlement", token=token)

        with (
            patch.dict(
                os.environ,
                {"VID2PPT_OWNER_USERNAMES": "", "VID2PPT_OWNER_EMAILS": ""},
            ),
            patch.object(entitlement, "find_entitlement", return_value=None),
        ):
            request.do_GET()

        response_payload = request.send_json.call_args.args[0]
        self.assertEqual(response_payload["effective_plan"], "free")
        self.assertFalse(response_payload["active"])


class OwnerConfigurationTests(unittest.TestCase):
    def test_owner_identity_has_no_built_in_usernames_or_emails(self) -> None:
        with patch.dict(
            os.environ,
            {"VID2PPT_OWNER_USERNAMES": "", "VID2PPT_OWNER_EMAILS": ""},
        ):
            self.assertFalse(
                _plans.is_owner_identity(
                    "twotigers_vid@users.vid2ppt.com",
                    "twotigers_vid",
                )
            )
            self.assertFalse(
                _plans.is_owner_identity("kcdesk@users.vid2ppt.com", "kcdesk")
            )

    def test_owner_identity_requires_explicit_environment_configuration(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VID2PPT_OWNER_USERNAMES": "configured_owner",
                "VID2PPT_OWNER_EMAILS": "owner@example.com",
            },
        ):
            self.assertTrue(_plans.is_owner_identity("", "configured_owner"))
            self.assertTrue(_plans.is_owner_identity("owner@example.com", ""))
            self.assertTrue(
                _plans.is_owner_identity(
                    "configured_owner@users.vid2ppt.com",
                    "",
                )
            )
            self.assertFalse(_plans.is_owner_identity("", "twotigers_vid"))


class AdminConfigurationTests(unittest.TestCase):
    def test_auth_storage_error_does_not_expose_database_setup_details(self) -> None:
        request = request_handler(auth)
        request.read_json = Mock(
            return_value={
                "action": "register",
                "username": "alice",
                "password": "test-password",
                "captcha_token": "token",
                "captcha_answer": "answer",
            }
        )

        with (
            patch.object(auth, "verify_captcha_response", return_value=True),
            patch.object(
                request,
                "register",
                side_effect=auth.SupabaseError(500, "missing site_users; run supabase/schema.sql"),
            ),
            patch.object(auth.LOGGER, "error") as log_error,
        ):
            request.do_POST()

        log_error.assert_called_once()
        request.send_json.assert_called_once_with(
            {"detail": "账号服务暂时不可用，请稍后重试。"},
            500,
        )

    def test_default_password_is_not_accepted_when_admin_password_is_unset(self) -> None:
        with patch.object(auth, "ADMIN_PASSWORD", ""):
            self.assertFalse(auth.is_admin_login(auth.ADMIN_USERNAME, "1108"))

    def test_auth_admin_login_stays_generic_when_configuration_is_missing(self) -> None:
        request = request_handler(auth)

        with (
            patch.object(auth, "ADMIN_PASSWORD", ""),
            patch.object(auth, "find_site_user_by_username", return_value=None),
            patch.object(auth, "ensure_admin_site_user") as ensure_admin,
        ):
            request.login(auth.ADMIN_USERNAME, "1108")

        ensure_admin.assert_not_called()
        request.send_json.assert_called_once_with({"detail": "用户名或密码不正确。"}, 401)

    def test_usage_admin_login_stays_generic_when_configuration_is_missing(self) -> None:
        request = request_handler(usage)

        with (
            patch.object(usage, "ADMIN_PASSWORD", ""),
            patch.object(usage, "create_admin_token") as create_token,
        ):
            request.handle_admin_login(
                {"username": usage.ADMIN_USERNAME, "password": "1108"}
            )

        create_token.assert_not_called()
        request.send_json.assert_called_once_with({"detail": "Invalid admin login"}, 401)

    def test_admin_login_works_only_after_explicit_password_configuration(self) -> None:
        with patch.object(auth, "ADMIN_PASSWORD", "configured-password"):
            self.assertTrue(
                auth.is_admin_login(auth.ADMIN_USERNAME, "configured-password")
            )
            self.assertFalse(auth.is_admin_login(auth.ADMIN_USERNAME, "1108"))

    def test_regular_session_never_infers_admin_access_from_username(self) -> None:
        request = request_handler(auth)
        user = {
            "id": "user-admin-name",
            "username": auth.ADMIN_USERNAME,
            "email": "owner@example.com",
        }

        with (
            patch.object(auth, "ADMIN_PASSWORD", "configured-password"),
            patch.object(auth, "create_user_token", return_value="user-token"),
            patch.object(auth, "create_admin_token") as create_admin,
        ):
            request.send_session(user)

        create_admin.assert_not_called()
        response_payload = request.send_json.call_args.args[0]
        self.assertEqual(response_payload["token"], "user-token")
        self.assertNotIn("admin_token", response_payload)


if __name__ == "__main__":
    unittest.main()
