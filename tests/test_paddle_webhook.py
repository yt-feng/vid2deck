from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "paddle_webhook_under_test",
    Path(__file__).resolve().parents[1] / "server_handlers" / "paddle-webhook.py",
)
assert spec and spec.loader
webhook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webhook)


class PurchasedPriceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            webhook.os.environ,
            {
                "PADDLE_PRICE_PRO_MONTHLY": "pri_pro",
                "PADDLE_PRICE_LIFETIME": "pri_lifetime",
                "PADDLE_PRICE_DAY_PASS": "pri_day",
            },
            clear=True,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_custom_data_price_does_not_grant_an_unpurchased_plan(self) -> None:
        event = {
            "event_id": "evt_unrelated_purchase",
            "event_type": "transaction.completed",
            "data": {
                "id": "txn_unrelated_purchase",
                "custom_data": {
                    "email": "buyer@example.test",
                    "claimed_price": "pri_lifetime",
                    "items": [{"price": {"id": "pri_lifetime"}}],
                },
                "items": [{"price": {"id": "pri_other_product"}, "quantity": 1}],
            },
        }
        with patch.object(webhook, "save_entitlement") as save, patch.object(webhook, "insert_usage_event") as log:
            result = webhook.process_event(event)

        self.assertFalse(result["processed"])
        self.assertEqual(result["detail"], "unrecognized price")
        save.assert_not_called()
        self.assertEqual(log.call_args.args[2]["price_ids"], ["pri_other_product"])

    def test_purchased_plan_wins_over_customer_metadata(self) -> None:
        event = {
            "event_id": "evt_pro_purchase",
            "event_type": "transaction.completed",
            "data": {
                "id": "txn_pro_purchase",
                "custom_data": {"email": "buyer@example.test", "claimed_price": "pri_lifetime"},
                "items": [{"price": {"id": "pri_pro"}, "quantity": 1}],
                "billing_period_end": "2099-10-03T12:00:00Z",
            },
        }
        with patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
            result = webhook.process_event(event)

        self.assertTrue(result["processed"])
        self.assertEqual(result["plan"], "pro")
        self.assertFalse(save.call_args.args[1]["lifetime"])

    def test_paddle_item_shapes_are_supported_without_scanning_other_fields(self) -> None:
        payloads = [
            {"items": [{"price": {"id": "pri_pro"}}]},
            {"items": [{"price_id": "pri_pro"}]},
            {"line_items": [{"price_id": "pri_pro"}]},
            {"details": {"line_items": [{"price_id": "pri_pro"}]}},
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                payload["custom_data"] = {"price_id": "pri_lifetime"}
                payload["metadata"] = {"price_id": "pri_day"}
                self.assertEqual(webhook.collect_price_ids(payload), ["pri_pro"])

    def test_price_ids_are_deduplicated_and_malformed_items_are_ignored(self) -> None:
        self.assertEqual(
            webhook.collect_price_ids({
                "items": [None, "pri_lifetime", {"price": "pri_lifetime"}, {"price_id": "not_a_price"}, {"price": {"id": "pri_pro"}}],
                "details": {"line_items": [{"price_id": "pri_pro"}]},
            }),
            ["pri_pro"],
        )

    def day_pass_event(self, quantity: int) -> dict:
        return {
            "event_id": "evt_day_purchase",
            "event_type": "transaction.completed",
            "data": {
                "id": "txn_day_purchase",
                "billed_at": "2026-10-03T12:00:00Z",
                "custom_data": {"email": "buyer@example.test"},
                "items": [{"price": {"id": "pri_day"}, "quantity": quantity}],
            },
        }

    def test_each_purchased_day_pass_grants_24_hours(self) -> None:
        for quantity, expected in ((1, "2026-10-04T12:00:00Z"), (10, "2026-10-13T12:00:00Z")):
            with self.subTest(quantity=quantity), patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
                result = webhook.process_event(self.day_pass_event(quantity))
                self.assertTrue(result["processed"])
                self.assertEqual(save.call_args.args[1]["current_period_end"], expected)

    def test_large_purchased_day_pass_quantities_are_fully_granted(self) -> None:
        for quantity, expected in ((1000, "2029-06-29T12:00:00Z"), (999999, "4764-08-29T12:00:00Z")):
            with self.subTest(quantity=quantity), patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
                result = webhook.process_event(self.day_pass_event(quantity))
                self.assertTrue(result["processed"])
                self.assertEqual(save.call_args.args[1]["current_period_end"], expected)

    def test_large_purchased_quantity_wins_over_conflicting_customer_claims(self) -> None:
        event = self.day_pass_event(1000)
        event["data"]["custom_data"].update({
            "quantity": 1,
            "pass_quantity": 1,
            "billing_quantity": 1,
            "items": [{"price": {"id": "pri_day"}, "quantity": 999999}],
        })
        event["data"]["items"].append({"price": {"id": "pri_other"}, "quantity": 999999})
        with patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
            webhook.process_event(event)
        self.assertEqual(save.call_args.args[1]["current_period_end"], "2029-06-29T12:00:00Z")

    def test_purchased_quantity_cap_prevents_datetime_overflow(self) -> None:
        event = self.day_pass_event(999999999)
        event["data"]["items"].append({"price": {"id": "pri_day"}, "quantity": 999999999})
        with patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
            result = webhook.process_event(event)
        self.assertTrue(result["processed"])
        self.assertEqual(save.call_args.args[1]["current_period_end"], "4764-08-29T12:00:00Z")

    def test_day_pass_quantity_and_purchase_time_ignore_customer_metadata(self) -> None:
        event = self.day_pass_event(1)
        event["data"]["custom_data"].update({
            "quantity": 999,
            "pass_quantity": 999,
            "billed_at": "2099-10-03T12:00:00Z",
            "items": [{"price": {"id": "pri_day"}, "quantity": 999}],
        })
        event["data"]["items"].append({"price": {"id": "pri_other"}, "quantity": 999})
        with patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"):
            webhook.process_event(event)
        self.assertEqual(save.call_args.args[1]["current_period_end"], "2026-10-04T12:00:00Z")

    def test_repeated_delivery_with_purchase_timestamp_does_not_extend_access(self) -> None:
        event = self.day_pass_event(10)
        with patch.object(webhook, "save_entitlement", side_effect=lambda email, fields: fields) as save, patch.object(webhook, "insert_usage_event"), patch.object(webhook, "future_iso") as future:
            webhook.process_event(event)
            webhook.process_event(event)
        self.assertEqual(
            [call.args[1]["current_period_end"] for call in save.call_args_list],
            ["2026-10-13T12:00:00Z", "2026-10-13T12:00:00Z"],
        )
        future.assert_not_called()

    def test_completed_timestamp_and_detailed_line_items_are_supported(self) -> None:
        data = {
            "completed_at": "2026-10-03T14:00:00+02:00",
            "details": {"line_items": [{"price_id": "pri_day", "quantity": 10}]},
        }
        self.assertEqual(webhook.current_period_end_for_plan("day_pass", False, data), "2026-10-13T12:00:00Z")

    def test_legacy_purchase_without_valid_timestamp_uses_current_time(self) -> None:
        data = self.day_pass_event(3)["data"]
        data["billed_at"] = "invalid timestamp"
        with patch.object(webhook, "future_iso", return_value="legacy_expiry") as future:
            self.assertEqual(webhook.current_period_end_for_plan("day_pass", False, data), "legacy_expiry")
        future.assert_called_once_with(days=3)

    def test_repeated_line_item_representations_do_not_double_quantity(self) -> None:
        data = self.day_pass_event(10)["data"]
        data["details"] = {"line_items": [{"price_id": "pri_day", "quantity": 10}]}
        self.assertEqual(webhook.current_period_end_for_plan("day_pass", False, data), "2026-10-13T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
