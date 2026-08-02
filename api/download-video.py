from __future__ import annotations

import base64
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import tempfile
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

import yt_dlp

try:
    from _bilibili import BilibiliError, download_bilibili_video, is_bilibili_url
except ModuleNotFoundError:
    from api._bilibili import BilibiliError, download_bilibili_video, is_bilibili_url


DEFAULT_MAX_DOWNLOAD_MB = 180
DEFAULT_YTDLP_FORMAT = (
    "best[height<=720][ext=mp4][vcodec!=none][acodec!=none]/"
    "best[height<=720][vcodec!=none][acodec!=none]/"
    "best[ext=mp4][vcodec!=none][acodec!=none]/best"
)
DEFAULT_YOUTUBE_PLAYER_CLIENTS = ""
DEFAULT_YOUTUBE_PLAYER_SKIP = ""
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
YOUTUBE_PROXY_ENV_NAMES = (
    "VID2PPT_YOUTUBE_PROXY",
    "VID2PPT_YTDLP_PROXY",
    "YTDLP_PROXY",
)
YOUTUBE_COOKIE_PLAYER_CLIENTS = "web_safari,mweb,tv"
MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".wav", ".opus"}


class DownloadError(Exception):
    pass


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if not url_import_enabled():
            self.send_json({"detail": "在线视频链接下载功能当前未开放，请直接上传视频文件。"}, 410)
            return
        self.send_json({"ok": True, "route": "/api/download-video", "method": "POST only"})

    def do_POST(self) -> None:
        if not url_import_enabled():
            self.send_json({"detail": "在线视频链接下载功能当前未开放，请直接上传视频文件。"}, 410)
            return
        downloaded: Path | None = None
        try:
            data = self.read_json()
            url = validate_url(str(data.get("url", "")).strip())
            rights_confirmed = bool(data.get("rightsConfirmed"))
            downloaded = download_url(url, rights_confirmed=rights_confirmed)
            self.send_file(downloaded)
        except BilibiliError as exc:
            self.send_json({"detail": str(exc)}, 400)
        except DownloadError as exc:
            self.send_json({"detail": str(exc)}, 400)
        except Exception as exc:
            self.send_json({"detail": clean_error(str(exc)) or "这个链接暂时无法获取。"}, 500)
        finally:
            if downloaded:
                shutil.rmtree(downloaded.parent, ignore_errors=True)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0 or length > 32 * 1024:
            raise DownloadError("请输入有效的视频链接。")
        body = self.rfile.read(length).decode("utf-8")
        data = json.loads(body or "{}")
        if not isinstance(data, dict):
            raise DownloadError("请输入有效的视频链接。")
        return data

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-Filename")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        filename = safe_filename(path.name)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", content_disposition(filename))
        self.send_header("X-Filename", ascii_filename(filename))
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, length=1024 * 1024)


def url_import_enabled() -> bool:
    return (os.getenv("VID2PPT_URL_IMPORT_ENABLED") or "").strip().lower() in {"1", "true", "yes", "on"}


def validate_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise DownloadError("请输入有效的 http 或 https 视频链接。")
    host = parsed.hostname or ""
    if not host or host.lower() == "localhost":
        raise DownloadError("请输入公开视频链接。")
    if host_is_private(host):
        raise DownloadError("请输入公开视频链接。")
    return value


def host_is_private(host: str) -> bool:
    try:
        addresses = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise DownloadError("无法解析这个链接。") from exc
    for item in addresses:
        ip = ipaddress.ip_address(item[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return True
    return False


def download_video(url: str) -> Path:
    max_download_mb, max_download_bytes = download_size_limit()
    youtube_url = is_youtube_url(url)
    if not youtube_url:
        try:
            return download_video_once(
                url,
                max_download_mb=max_download_mb,
                max_download_bytes=max_download_bytes,
                use_youtube_cookies=False,
                use_youtube_proxy=False,
            )
        except DownloadError:
            raise
        except Exception as exc:
            raise_download_error(clean_error(str(exc)), max_download_mb, exc)

    has_cookies = bool(youtube_cookie_file_content())
    has_proxy = bool(youtube_proxy_url())
    attempts = [(False, False)]
    if has_cookies:
        attempts.append((True, False))
    if has_proxy:
        attempts.append((False, True))
    if has_cookies and has_proxy:
        attempts.append((True, True))

    errors: list[tuple[str, Exception]] = []
    for use_cookies, use_proxy in attempts:
        try:
            return download_video_once(
                url,
                max_download_mb=max_download_mb,
                max_download_bytes=max_download_bytes,
                use_youtube_cookies=use_cookies,
                use_youtube_proxy=use_proxy,
            )
        except DownloadError as exc:
            message = clean_error(str(exc))
            if "超过" in message and "MB" in message:
                raise
            errors.append((message, exc))
        except Exception as exc:
            errors.append((clean_error(str(exc)), exc))

    messages = [message for message, _ in errors if message]
    cause = errors[-1][1] if errors else RuntimeError("YouTube download failed")
    raise DownloadError(friendly_youtube_error(messages, max_download_mb, has_cookies)) from cause


def download_video_once(
    url: str,
    *,
    max_download_mb: int,
    max_download_bytes: int,
    use_youtube_cookies: bool,
    use_youtube_proxy: bool,
) -> Path:
    tempdir = Path(tempfile.mkdtemp(prefix="vid2ppt-cloud-download-"))
    outtmpl = str(tempdir / "%(title).160B-%(id)s.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": os.getenv("VID2PPT_CLOUD_YTDLP_FORMAT", DEFAULT_YTDLP_FORMAT),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
        "max_filesize": max_download_bytes,
        "retries": 2,
        "fragment_retries": 2,
        "socket_timeout": 20,
        "cachedir": False,
    }
    extractor_args = youtube_extractor_args(url, use_youtube_cookies=use_youtube_cookies)
    if extractor_args:
        ydl_opts["extractor_args"] = extractor_args
    if use_youtube_proxy and is_youtube_url(url):
        if proxy := youtube_proxy_url():
            ydl_opts["proxy"] = proxy
    if use_youtube_cookies and is_youtube_url(url):
        if cookiefile := write_youtube_cookie_file(tempdir):
            ydl_opts["cookiefile"] = str(cookiefile)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(url, download=True)
        media = find_downloaded_media(tempdir)
        if media.stat().st_size > max_download_bytes:
            raise DownloadError(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。")
        return media
    except DownloadError:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise


def raise_download_error(message: str, max_download_mb: int, exc: Exception) -> None:
    if "Requested format is not available" in message:
        raise DownloadError("这个链接暂时没有可直接处理的视频格式。") from exc
    if "File is larger than max-filesize" in message:
        raise DownloadError(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。") from exc
    if youtube_requires_sign_in(message):
        raise DownloadError("YouTube 要求登录或真人验证，已尝试服务端 YouTube Cookie 后仍无法获取。") from exc
    raise DownloadError(message or "这个链接暂时无法获取。") from exc


def friendly_youtube_error(messages: list[str], max_download_mb: int, has_cookies: bool) -> str:
    combined = " ".join(messages)
    if "File is larger than max-filesize" in combined or ("超过" in combined and "MB" in combined):
        return f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。"
    if "Requested format is not available" in combined:
        return "YouTube 当前没有返回可处理的视频格式，请稍后重试。"
    if youtube_requires_sign_in(combined):
        return "YouTube 当前要求登录或真人验证，已尝试登录态后仍未获取到视频。" if has_cookies else "YouTube 当前要求登录或真人验证，请稍后重试。"
    if "403" in combined or "Forbidden" in combined or "proxy" in combined.lower():
        return "YouTube 暂时拒绝了云端视频请求，已自动尝试备用线路，请稍后重试。"
    return "YouTube 暂时没有返回可处理的视频流，请稍后重试。"


def download_url(url: str, *, rights_confirmed: bool = False) -> Path:
    max_download_mb, max_download_bytes = download_size_limit()
    if is_bilibili_url(url):
        if not rights_confirmed:
            raise DownloadError("请先确认你有权保存、转换或分析这个 B 站视频。")
        try:
            return download_bilibili_video(url, max_download_bytes=max_download_bytes)
        except BilibiliError as exc:
            message = str(exc)
            if "超过当前下载大小限制" in message:
                raise DownloadError(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。") from exc
            raise
    return download_video(url)


def download_size_limit() -> tuple[int, int]:
    max_download_mb = int(os.getenv("VID2PPT_CLOUD_MAX_DOWNLOAD_MB", str(DEFAULT_MAX_DOWNLOAD_MB)))
    return max_download_mb, max(1, max_download_mb) * 1024 * 1024


def youtube_extractor_args(url: str, *, use_youtube_cookies: bool = False) -> dict[str, dict[str, list[str]]] | None:
    if not is_youtube_url(url):
        return None
    args: dict[str, list[str]] = {}
    default_clients = YOUTUBE_COOKIE_PLAYER_CLIENTS if use_youtube_cookies else DEFAULT_YOUTUBE_PLAYER_CLIENTS
    clients = csv_env("VID2PPT_YOUTUBE_PLAYER_CLIENTS", default_clients)
    if clients:
        args["player_client"] = clients
    player_skip = csv_env("VID2PPT_YOUTUBE_PLAYER_SKIP", DEFAULT_YOUTUBE_PLAYER_SKIP)
    if player_skip:
        args["player_skip"] = player_skip
    return {"youtube": args} if args else None


def youtube_proxy_url() -> str:
    for env_name in YOUTUBE_PROXY_ENV_NAMES:
        value = (os.getenv(env_name) or "").strip()
        if value:
            return value
    return ""


def write_youtube_cookie_file(directory: Path) -> Path | None:
    content = youtube_cookie_file_content()
    if not content:
        return None
    path = directory / "youtube-cookies.txt"
    path.write_text(content, encoding="utf-8")
    return path


def youtube_cookie_file_content() -> str:
    for env_name in YOUTUBE_COOKIE_B64_ENV_NAMES:
        value = (os.getenv(env_name) or "").strip()
        if value:
            try:
                decoded = base64.b64decode(value).decode("utf-8")
            except Exception:
                return ""
            return normalize_netscape_cookie_text(decoded)

    for env_name in YOUTUBE_COOKIE_TEXT_ENV_NAMES:
        value = (os.getenv(env_name) or "").strip()
        if value:
            return normalize_netscape_cookie_text(value)
    return ""


def normalize_netscape_cookie_text(content: str) -> str:
    text = content.strip()
    if "\\n" in text and "\n" not in text:
        text = text.replace("\\n", "\n")
    if not text.startswith("# Netscape"):
        text = "# Netscape HTTP Cookie File\n" + text
    return text.rstrip() + "\n"


def csv_env(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


def is_youtube_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")


def find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in MEDIA_SUFFIXES and not path.name.endswith(".part")
    ]
    if not candidates:
        raise DownloadError("没有获取到可处理的视频文件。")
    return max(candidates, key=lambda item: item.stat().st_size)


def safe_filename(name: str) -> str:
    cleaned = re.sub(r"[\x00-\x1f\\/:*?\"<>|]+", "_", Path(name).name).strip(" .")
    return cleaned[:180] or "online-video.mp4"


def ascii_filename(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return safe[:160] or "online-video.mp4"


def content_disposition(filename: str) -> str:
    fallback = ascii_filename(filename)
    encoded = urllib.parse.quote(filename)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def clean_error(message: str) -> str:
    return re.sub(r"\s+", " ", message.replace("ERROR:", "")).strip()


def youtube_requires_sign_in(message: str) -> bool:
    lowered = message.lower()
    return (
        "sign in to confirm" in lowered
        or "not a bot" in lowered
        or "cookies-from-browser" in lowered
        or "cookies for the authentication" in lowered
    )
