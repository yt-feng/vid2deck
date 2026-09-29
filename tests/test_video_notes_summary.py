from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("video_notes_summary", ROOT / "server_handlers" / "summarize-simple.py")
assert SPEC and SPEC.loader
summary_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary_api)


def request_handler(transcript: str) -> object:
    instance = object.__new__(summary_api.handler)
    instance.headers = {"authorization": "Bearer fixture"}
    instance.read_json = Mock(return_value={"transcript": transcript, "mode": "illustrated_notes"})
    instance.send_json = Mock()
    return instance


class VideoNotesSummaryTests(unittest.TestCase):
    def test_overlong_transcript_is_rejected_before_quota_generation_or_usage(self) -> None:
        request = request_handler("文" * (summary_api.MAX_TRANSCRIPT_CHARACTERS + 1))
        with (
            patch.object(summary_api, "authorized_user", return_value={"email": "reader@example.com"}),
            patch.object(summary_api, "ensure_summary_quota") as quota,
            patch.object(summary_api, "make_summary") as generate,
            patch.object(summary_api, "insert_usage_event") as record,
        ):
            request.do_POST()
        quota.assert_not_called()
        generate.assert_not_called()
        record.assert_not_called()
        payload, status = request.send_json.call_args.args
        self.assertEqual(status, 422)
        self.assertIn("60,000", payload["detail"])
        self.assertNotIn("summary", payload)

    def test_exact_limit_is_accepted_and_last_source_character_reaches_generator(self) -> None:
        transcript = "文" * (summary_api.MAX_TRANSCRIPT_CHARACTERS - 1) + "末"
        request = request_handler(transcript)
        with (
            patch.object(summary_api, "authorized_user", return_value={"email": ""}),
            patch.object(summary_api, "make_summary", return_value="真实笔记") as generate,
        ):
            request.do_POST()
        generate.assert_called_once_with(transcript, "zh-CN", "illustrated_notes", "")
        request.send_json.assert_called_once_with({"summary": "真实笔记", "mode": "illustrated_notes", "language": "zh-CN"})

    def test_direct_generation_also_rejects_overlong_input_without_provider_request(self) -> None:
        with patch.object(summary_api, "urlopen") as request:
            with self.assertRaises(summary_api.TranscriptLengthError):
                summary_api.make_summary("x" * (summary_api.MAX_TRANSCRIPT_CHARACTERS + 1))
        request.assert_not_called()

    def test_provider_receives_complete_source_in_each_mode(self) -> None:
        transcript = "文" * (summary_api.MAX_TRANSCRIPT_CHARACTERS - len("SOURCE_END")) + "SOURCE_END"
        for mode in ("summary", "illustrated_notes"):
            with self.subTest(mode=mode):
                response = io.BytesIO(json.dumps({"choices": [{"message": {"content": "  # 笔记\n内容  "}}]}).encode())
                with (
                    patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-only-key"}),
                    patch.object(summary_api, "urlopen", return_value=response) as provider,
                ):
                    result = summary_api.make_summary(transcript, "en", mode, "原始文件.mp4")
                payload = json.loads(provider.call_args.args[0].data)
                self.assertEqual(payload["messages"][1]["content"].split("逐字稿：\n", 1)[1], transcript)
                self.assertEqual(result, "# 笔记\n内容")
                self.assertEqual(payload["temperature"], 0.2)


if __name__ == "__main__":
    unittest.main()
