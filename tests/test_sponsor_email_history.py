from __future__ import annotations

import pathlib
import unittest
import urllib.parse
from unittest import mock

from api import _supabase, usage


ROOT = pathlib.Path(__file__).resolve().parents[1]


class SponsorEmailHistoryTests(unittest.TestCase):
    def test_supabase_email_query_returns_every_matching_order(self) -> None:
        rows = [{"request_id": "sp_first"}, {"request_id": "sp_second"}]
        with mock.patch.object(_supabase, "supabase_request", return_value=rows) as request:
            result = _supabase.list_sponsor_orders_by_email("buyer+nova@example.com")

        self.assertEqual(result, rows)
        path = request.call_args.args[1]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        self.assertEqual(query["email"], ["eq.buyer+nova@example.com"])
        self.assertEqual(query["order"], ["created_at.desc"])
        self.assertEqual(query["limit"], ["500"])

    def test_api_payload_keeps_completed_and_pending_orders(self) -> None:
        rows = [
            {
                "request_id": "sp_completed",
                "plan_code": "PLAN-MONTH",
                "status": "completed",
                "code": "V2D-AAAA-BBBB-CCCC",
                "amount_cny": "66.00",
                "paddle_transaction_id": "txn_completed",
                "created_at": "2026-07-26T10:00:00Z",
                "completed_at": "2026-07-26T10:01:00Z",
            },
            {
                "request_id": "sp_pending",
                "plan_code": "PLAN-QUARTER",
                "status": "checkout_opened",
                "code": None,
                "amount_cny": "178.00",
                "created_at": "2026-07-25T10:00:00Z",
            },
        ]
        with mock.patch.object(usage, "list_sponsor_orders_by_email", return_value=rows) as query:
            payload = usage.sponsor_orders_payload("buyer@example.com")

        query.assert_called_once_with("buyer@example.com", limit=500)
        self.assertEqual(payload["count"], 2)
        self.assertEqual([row["request_id"] for row in payload["orders"]], ["sp_completed", "sp_pending"])
        self.assertEqual(payload["orders"][0]["code"], "V2D-AAAA-BBBB-CCCC")
        self.assertIsNone(payload["orders"][1]["code"])
        self.assertEqual(payload["orders"][0]["paddle_transaction_id"], "txn_completed")

    def test_sponsor_url_opens_the_simple_tip_dialog(self) -> None:
        sponsor_source = (ROOT / "public" / "sponsor" / "index.html").read_text(encoding="utf-8")
        index_source = (ROOT / "index.html").read_text(encoding="utf-8")
        app_source = (ROOT / "src" / "main.ts").read_text(encoding="utf-8")

        self.assertIn("/?sponsor=1", sponsor_source)
        self.assertNotIn("emailLookupBtn", sponsor_source)
        self.assertNotIn("requestLookup", sponsor_source)
        self.assertIn('id="openSiteTipDialogBtn"', index_source)
        self.assertIn("const TIP_AMOUNTS = [10, 20, 50, 80, 100, 200]", app_source)
        self.assertIn("openTipDialogBtn.addEventListener('click', () => openTipDialog())", app_source)
        self.assertIn("get('sponsor') === '1'", app_source)


if __name__ == "__main__":
    unittest.main()
