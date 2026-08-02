from __future__ import annotations

import base64
import json
import os
import pathlib
import unittest
from unittest import mock

from api._external_grant import external_link_enabled, resolve_external_benefit


ROOT = pathlib.Path(__file__).resolve().parents[1]


class DetachedIntegrationTests(unittest.TestCase):
    def test_sponsor_page_has_no_private_integration_details(self) -> None:
        source = (ROOT / "public" / "sponsor" / "index.html").read_text(encoding="utf-8")

        self.assertNotIn("gift_benefit_site", source)
        self.assertIn("/?sponsor=1", source)

    def test_external_benefit_defaults_off(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(external_link_enabled())
            self.assertEqual((None, None), resolve_external_benefit("PLAN-A"))

    def test_external_benefit_uses_private_profile(self) -> None:
        profile = {
            "version": 1,
            "grant_url": "https://partner.invalid/grant",
            "plan_codes": ["PLAN-A"],
            "benefit_site": "partner",
            "benefit_plan_by_code": {"PLAN-A": "member"},
            "gift_benefit_site": "partner.invalid",
            "metadata_key": "partner_grant",
            "user_agent": "Vid2PPT-External-Grant/1.0",
        }
        encoded = base64.b64encode(
            json.dumps(profile, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        with mock.patch.dict(
            os.environ,
            {
                "VID2PPT_EXTERNAL_LINK_ENABLED": "true",
                "VID2PPT_EXTERNAL_GRANT_CONFIG_B64": encoded,
            },
            clear=True,
        ):
            config, benefit_plan = resolve_external_benefit("plan-a")

        self.assertIsNotNone(config)
        self.assertEqual("partner", config.benefit_site)
        self.assertEqual("member", benefit_plan)

    def test_public_tree_has_no_private_target_identifier(self) -> None:
        blocked = ("kc" + "desk").casefold()
        roots = ("api", "docs", "tests", "public", "src", ".github")
        suffixes = {".py", ".ts", ".tsx", ".js", ".json", ".md", ".html", ".yml", ".yaml"}
        matches: list[str] = []
        for root_name in roots:
            root = ROOT / root_name
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file() and path.suffix.lower() in suffixes:
                    text = path.read_text(encoding="utf-8", errors="ignore").casefold()
                    if blocked in text:
                        matches.append(str(path.relative_to(ROOT)))
        self.assertEqual([], matches)

    def test_url_import_is_hidden_and_server_routes_are_gone(self) -> None:
        main = (ROOT / "src" / "main.ts").read_text(encoding="utf-8")
        downloader = (ROOT / "api" / "download-video.py").read_text(encoding="utf-8")
        metadata = (ROOT / "api" / "media" / "metadata.py").read_text(encoding="utf-8")
        fallback = (ROOT / "api" / "youtube-fallback.ts").read_text(encoding="utf-8")

        self.assertIn("VITE_URL_IMPORT_ENABLED", main)
        self.assertIn("VITE_SCREEN_RECORDING_ENABLED", main)
        self.assertIn("URL_IMPORT_ENABLED ? '' : 'hidden aria-hidden=", main)
        self.assertIn("SCREEN_RECORDING_ENABLED ? '' : 'hidden aria-hidden=", main)
        self.assertIn("VID2PPT_URL_IMPORT_ENABLED", downloader)
        self.assertIn("VID2PPT_URL_IMPORT_ENABLED", metadata)
        self.assertIn("VID2PPT_URL_IMPORT_ENABLED", fallback)
        self.assertGreaterEqual(downloader.count("410"), 2)
        self.assertGreaterEqual(metadata.count("410"), 2)
        self.assertGreaterEqual(fallback.count("410"), 2)


if __name__ == "__main__":
    unittest.main()
