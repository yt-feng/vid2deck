from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import MagicMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative_path: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# These lifecycle tests never import a real downloader or access the network.
downloader = ModuleType("yt_dlp")
downloader.YoutubeDL = Mock()
with patch.dict(sys.modules, {"yt_dlp": downloader}):
    bilibili = load_module("test_media_bilibili", "api/_bilibili.py")
    with patch.dict(sys.modules, {"_bilibili": bilibili}):
        cloud = load_module("test_media_download", "api/media/download.py")


class CancelledDownload(BaseException):
    pass


class DisconnectedWriter:
    def write(self, data: bytes) -> None:
        raise BrokenPipeError("client disconnected")


class MediaTempCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.TemporaryDirectory(prefix="vid2ppt-cleanup-test-")
        self.addCleanup(self.root.cleanup)
        self.created: list[Path] = []
        real_mkdtemp = tempfile.mkdtemp

        def make_tempdir(suffix=None, prefix=None, dir=None):
            directory = real_mkdtemp(suffix=suffix, prefix=prefix, dir=self.root.name)
            self.created.append(Path(directory))
            return directory

        self.start_patch(patch.object(tempfile, "mkdtemp", side_effect=make_tempdir))
        self.start_patch(patch.dict(os.environ, {}, clear=True))
        self.start_patch(patch.object(cloud, "write_youtube_cookie_file", side_effect=self.write_cookie))
        self.start_patch(patch.object(bilibili, "write_bilibili_cookie_file", side_effect=self.write_cookie))
        self.constructor = self.start_patch(patch.object(downloader, "YoutubeDL"))

    def start_patch(self, patcher):
        mocked = patcher.start()
        self.addCleanup(patcher.stop)
        return mocked

    @staticmethod
    def write_cookie(directory: Path) -> Path:
        cookie = directory / "test-cookie.txt"
        cookie.write_bytes(b"test-only")
        return cookie

    def fake_downloader(self, *, error: BaseException | None = None, body: bytes | None = b"ok") -> None:
        def make_downloader(options):
            instance = MagicMock()
            instance.__enter__.return_value = instance

            def extract_info(url, *, download):
                if download:
                    directory = Path(options["outtmpl"]).parent
                    if error:
                        (directory / "video.mp4.part").write_bytes(b"partial")
                    elif body is not None:
                        (directory / "video.mp4").write_bytes(body)
                if error:
                    raise error
                return {"title": "Test video"}

            instance.extract_info.side_effect = extract_info
            return instance

        self.constructor.side_effect = make_downloader

    @staticmethod
    def download(provider: str, *, max_bytes: int = 8) -> Path:
        if provider == "cloud":
            return cloud.download_video_once(
                "https://www.youtube.com/watch?v=test-only",
                max_download_mb=1,
                max_download_bytes=max_bytes,
                use_youtube_cookies=True,
                use_youtube_proxy=False,
            )
        return bilibili.download_bilibili_video(
            "https://www.bilibili.com/video/test-only", max_download_bytes=max_bytes
        )

    def assert_last_directory_removed(self) -> None:
        self.assertTrue(self.created)
        self.assertFalse(self.created[-1].exists())

    def test_cookie_preparation_failure_removes_directory_and_partial_cookie(self) -> None:
        def failed_cookie(directory):
            self.write_cookie(directory)
            raise OSError("cookie write failed")

        for provider, module, cookie_writer, expected_error in (
            ("cloud", cloud, "write_youtube_cookie_file", OSError),
            ("bilibili", bilibili, "write_bilibili_cookie_file", bilibili.BilibiliError),
        ):
            with self.subTest(provider=provider):
                with patch.object(module, cookie_writer, side_effect=failed_cookie):
                    with self.assertRaises(expected_error):
                        self.download(provider)
                self.assert_last_directory_removed()
        self.constructor.assert_not_called()

    def test_cancellation_during_preparation_removes_directory(self) -> None:
        for provider, module, cookie_writer in (
            ("cloud", cloud, "write_youtube_cookie_file"),
            ("bilibili", bilibili, "write_bilibili_cookie_file"),
        ):
            with self.subTest(provider=provider):
                with patch.object(module, cookie_writer, side_effect=CancelledDownload("cancelled")):
                    with self.assertRaises(CancelledDownload):
                        self.download(provider)
                self.assert_last_directory_removed()

    def test_downloader_constructor_failure_removes_directory(self) -> None:
        self.constructor.side_effect = OSError("downloader unavailable")
        for provider, expected_error in (("cloud", OSError), ("bilibili", bilibili.BilibiliError)):
            with self.subTest(provider=provider):
                with self.assertRaises(expected_error):
                    self.download(provider)
                self.assert_last_directory_removed()

    def test_download_timeout_removes_partial_media_and_cookie(self) -> None:
        self.fake_downloader(error=TimeoutError("download timed out"))
        for provider, expected_error in (("cloud", TimeoutError), ("bilibili", bilibili.BilibiliError)):
            with self.subTest(provider=provider):
                with self.assertRaises(expected_error):
                    self.download(provider)
                self.assert_last_directory_removed()

    def test_cancellation_during_download_removes_partial_media_and_cookie(self) -> None:
        self.fake_downloader(error=CancelledDownload("cancelled"))
        for provider in ("cloud", "bilibili"):
            with self.subTest(provider=provider):
                with self.assertRaises(CancelledDownload):
                    self.download(provider)
                self.assert_last_directory_removed()

    def test_oversized_result_is_removed(self) -> None:
        self.fake_downloader(body=b"too large")
        for provider, expected_error in (("cloud", cloud.DownloadError), ("bilibili", bilibili.BilibiliError)):
            with self.subTest(provider=provider):
                with self.assertRaises(expected_error):
                    self.download(provider, max_bytes=1)
                self.assert_last_directory_removed()

    def test_missing_media_removes_cookie_and_directory(self) -> None:
        self.fake_downloader(body=None)
        for provider, expected_error in (("cloud", cloud.DownloadError), ("bilibili", bilibili.BilibiliError)):
            with self.subTest(provider=provider):
                with self.assertRaises(expected_error):
                    self.download(provider)
                self.assert_last_directory_removed()

    def test_success_keeps_media_available_for_handler(self) -> None:
        self.fake_downloader()
        for provider in ("cloud", "bilibili"):
            with self.subTest(provider=provider):
                media = self.download(provider)
                self.assertEqual(media.read_bytes(), b"ok")
                self.assertEqual(media.parent, self.created[-1])
                self.assertTrue((media.parent / "test-cookie.txt").exists())

    @staticmethod
    def request_handler(writer=None):
        instance = object.__new__(cloud.handler)
        instance.read_json = Mock(return_value={"url": "https://example.com/video"})
        instance.send_response = Mock()
        instance.send_header = Mock()
        instance.end_headers = Mock()
        instance.wfile = writer if writer is not None else io.BytesIO()
        return instance

    def test_handler_transmits_media_then_removes_directory(self) -> None:
        self.fake_downloader()
        for provider in ("cloud", "bilibili"):
            with self.subTest(provider=provider):
                request = self.request_handler()
                with patch.object(cloud, "validate_url", side_effect=lambda url: url):
                    with patch.object(cloud, "download_url", side_effect=lambda *args, **kwargs: self.download(provider)):
                        request.do_POST()
                self.assertEqual(request.wfile.getvalue(), b"ok")
                request.send_response.assert_called_once_with(200)
                request.send_header.assert_any_call("Cache-Control", "no-store")
                self.assert_last_directory_removed()

    def test_client_disconnect_still_removes_directory_when_error_response_also_fails(self) -> None:
        self.fake_downloader()
        for provider in ("cloud", "bilibili"):
            with self.subTest(provider=provider):
                request = self.request_handler(DisconnectedWriter())
                with patch.object(cloud, "validate_url", side_effect=lambda url: url):
                    with patch.object(cloud, "download_url", side_effect=lambda *args, **kwargs: self.download(provider)):
                        with self.assertRaises(BrokenPipeError):
                            request.do_POST()
                self.assert_last_directory_removed()

    def test_metadata_cookie_directory_is_removed_on_success_and_timeout(self) -> None:
        for error in (None, TimeoutError("metadata timed out")):
            with self.subTest(error=error):
                self.fake_downloader(error=error)
                if error:
                    with self.assertRaises(bilibili.BilibiliError):
                        bilibili.get_bilibili_metadata("https://www.bilibili.com/video/test-only")
                else:
                    result = bilibili.get_bilibili_metadata("https://www.bilibili.com/video/test-only")
                    self.assertEqual(result["title"], "Test video")
                self.assert_last_directory_removed()


if __name__ == "__main__":
    unittest.main()
