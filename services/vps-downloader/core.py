from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
import urllib.parse
from pathlib import Path


DEFAULT_MAX_DOWNLOAD_MB = 180
MEDIA_SUFFIXES = {
    ".avi",
    ".m4a",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".opus",
    ".wav",
    ".webm",
}
YOUTUBE_COOKIE_B64_ENV_NAMES = (
    "YOUTUBE_COOKIES_NETSCAPE_B64",
    "YOUTUBE_COOKIE_NETSCAPE_B64",
    "VID2PPT_YOUTUBE_COOKIES_NETSCAPE_B64",
)
YOUTUBE_COOKIE_TEXT_ENV_NAMES = (
    "YOUTUBE_COOKIES_NETSCAPE",
    "YOUTUBE_COOKIE_NETSCAPE",
    "VID2PPT_YOUTUBE_COOKIES_NETSCAPE",
)


class DownloadProblem(Exception):
    """An expected download failure that is safe to show to the caller."""


def valid_download_signature(
    token: str,
    expires: int | None,
    signature: str | None,
    canonical_url: str,
    *,
    now: int | None = None,
    max_future_seconds: int = 600,
    clock_skew_seconds: int = 30,
) -> bool:
    if not token or expires is None or not signature:
        return False
    current = int(time.time()) if now is None else now
    if expires < current - clock_skew_seconds or expires > current + max_future_seconds:
        return False
    message = f"v1\n{expires}\n{canonical_url}".encode("utf-8")
    expected = hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def normalize_youtube_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlparse(value.strip())
    except ValueError as exc:
        raise DownloadProblem("请输入有效的 YouTube 视频链接。") from exc

    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise DownloadProblem("请输入有效的 YouTube 视频链接。")

    host = (parsed.hostname or "").lower().rstrip(".")
    candidate = ""
    if host == "youtu.be":
        candidate = next(iter(part for part in parsed.path.split("/") if part), "")
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        query = urllib.parse.parse_qs(parsed.query)
        candidate = (query.get("v") or [""])[0]
        if not candidate:
            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"embed", "live", "shorts"}:
                candidate = parts[1]

    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate):
        raise DownloadProblem("请输入有效的 YouTube 视频链接。")
    return f"https://www.youtube.com/watch?v={candidate}"


def positive_integer(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def download_size_limit() -> tuple[int, int]:
    megabytes = positive_integer(
        os.getenv("VID2PPT_CLOUD_MAX_DOWNLOAD_MB"),
        DEFAULT_MAX_DOWNLOAD_MB,
    )
    return megabytes, megabytes * 1024 * 1024


def youtube_cookie_file_content() -> str:
    for name in YOUTUBE_COOKIE_B64_ENV_NAMES:
        value = (os.getenv(name) or "").strip()
        if not value:
            continue
        try:
            decoded = base64.b64decode(value, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            continue
        normalized = normalize_netscape_cookie_text(decoded)
        if normalized:
            return normalized

    for name in YOUTUBE_COOKIE_TEXT_ENV_NAMES:
        value = (os.getenv(name) or "").strip()
        if value:
            return normalize_netscape_cookie_text(value)
    return ""


def normalize_netscape_cookie_text(content: str) -> str:
    text = content.strip()
    if "\\n" in text and "\n" not in text:
        text = text.replace("\\n", "\n")
    if not text:
        return ""
    if not text.startswith("# Netscape"):
        text = "# Netscape HTTP Cookie File\n" + text
    return text.rstrip() + "\n"


def find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.rglob("*")
        if path.is_file()
        and path.suffix.lower() in MEDIA_SUFFIXES
        and not path.name.endswith(".part")
    ]
    if not candidates:
        raise DownloadProblem("没有获取到可处理的 YouTube 视频文件。")
    return max(candidates, key=lambda item: item.stat().st_size)


def safe_filename(name: str) -> str:
    cleaned = re.sub(r"[\x00-\x1f\\/:*?\"<>|]+", "_", Path(name).name).strip(" .")
    return cleaned[:180] or "youtube-video.mp4"


def ascii_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return cleaned[:160] or "youtube-video.mp4"


def clean_error(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("ERROR:", "")).strip()


def friendly_youtube_error(messages: list[str], max_download_mb: int, has_cookies: bool) -> str:
    combined = " ".join(messages)
    lowered = combined.lower()
    if "file is larger than max-filesize" in lowered or "download exceeded" in lowered:
        return f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。"
    if "requested format is not available" in lowered:
        return "YouTube 当前没有返回可处理的视频格式，请稍后重试。"
    if any(marker in lowered for marker in (
        "sign in to confirm",
        "not a bot",
        "cookies-from-browser",
        "cookies for the authentication",
    )):
        if has_cookies:
            return "YouTube 当前要求登录或真人验证，固定 IP 与登录态均未获取到视频。"
        return "YouTube 当前要求登录或真人验证，固定 IP 暂时未获取到视频。"
    if "403" in combined or "forbidden" in lowered:
        return "YouTube 暂时拒绝了固定 IP 的视频请求，请稍后重试。"
    return "VPS 上的 yt-dlp 暂时没有返回可处理的视频流，请稍后重试。"
