from __future__ import annotations

import base64
import hashlib
import hmac
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import (  # noqa: E402
    DownloadProblem,
    ascii_filename,
    find_downloaded_media,
    normalize_youtube_url,
    safe_filename,
    valid_download_signature,
    youtube_cookie_file_content,
)


class CoreTests(unittest.TestCase):
    def test_normalizes_supported_youtube_urls(self) -> None:
        expected = "https://www.youtube.com/watch?v=JbwOH_U-OoU"
        self.assertEqual(normalize_youtube_url("https://youtu.be/JbwOH_U-OoU?t=3"), expected)
        self.assertEqual(normalize_youtube_url("https://www.youtube.com/watch?v=JbwOH_U-OoU"), expected)
        self.assertEqual(normalize_youtube_url("https://youtube.com/shorts/JbwOH_U-OoU"), expected)

    def test_rejects_non_youtube_and_credential_urls(self) -> None:
        for value in (
            "https://example.com/JbwOH_U-OoU",
            "http://user:pass@youtube.com/watch?v=JbwOH_U-OoU",
            "https://youtube.com/watch?v=short",
        ):
            with self.subTest(value=value), self.assertRaises(DownloadProblem):
                normalize_youtube_url(value)

    def test_cookie_reader_skips_malformed_first_alias(self) -> None:
        cookie = ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue"
        encoded = base64.b64encode(cookie.encode()).decode()
        with patch.dict(os.environ, {
            "YOUTUBE_COOKIES_NETSCAPE_B64": "not-valid-base64",
            "YOUTUBE_COOKIE_NETSCAPE_B64": encoded,
        }, clear=True):
            result = youtube_cookie_file_content()
        self.assertTrue(result.startswith("# Netscape HTTP Cookie File\n"))
        self.assertIn("SID\tvalue", result)

    def test_finds_largest_media_and_sanitizes_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "small.mp4").write_bytes(b"1")
            (root / "large.webm").write_bytes(b"123")
            (root / "ignored.mp4.part").write_bytes(b"12345")
            self.assertEqual(find_downloaded_media(root).name, "large.webm")
        self.assertEqual(safe_filename('../bad:name?.mp4'), "bad_name_.mp4")
        self.assertEqual(ascii_filename("中文 视频.mp4"), "mp4")

    def test_validates_short_lived_url_bound_signature(self) -> None:
        token = "a" * 64
        url = "https://www.youtube.com/watch?v=JbwOH_U-OoU"
        expires = 1_000_300
        message = f"v1\n{expires}\n{url}".encode()
        signature = hmac.new(token.encode(), message, hashlib.sha256).hexdigest()
        self.assertTrue(valid_download_signature(token, expires, signature, url, now=1_000_000))
        self.assertFalse(valid_download_signature(token, expires, signature, url + "x", now=1_000_000))
        self.assertFalse(valid_download_signature(token, expires, signature, url, now=1_001_000))


if __name__ == "__main__":
    unittest.main()
