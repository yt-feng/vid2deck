from __future__ import annotations

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


DEFAULT_MAX_DOWNLOAD_MB = 180
DEFAULT_YTDLP_FORMAT = (
    "best[height<=720][ext=mp4][vcodec!=none][acodec!=none]/"
    "best[height<=720][vcodec!=none][acodec!=none]/"
    "best[ext=mp4][vcodec!=none][acodec!=none]/best"
)
MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".wav", ".opus"}


class DownloadError(Exception):
    pass


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        self.send_json({"ok": True, "route": "/api/download-video", "method": "POST only"})

    def do_POST(self) -> None:
        downloaded: Path | None = None
        try:
            data = self.read_json()
            url = validate_url(str(data.get("url", "")).strip())
            downloaded = download_video(url)
            self.send_file(downloaded)
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
    max_download_mb = int(os.getenv("VID2PPT_CLOUD_MAX_DOWNLOAD_MB", str(DEFAULT_MAX_DOWNLOAD_MB)))
    max_download_bytes = max(1, max_download_mb) * 1024 * 1024
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
        message = clean_error(str(exc))
        if "Requested format is not available" in message:
            raise DownloadError("这个链接暂时没有可直接处理的视频格式。") from exc
        if "File is larger than max-filesize" in message:
            raise DownloadError(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。") from exc
        if youtube_requires_sign_in(message):
            raise DownloadError("YouTube 要求登录或真人验证，网页版无法读取你的 YouTube Cookie。请改用屏幕录制，或先把视频保存到本地后上传。") from exc
        raise DownloadError(message or "这个链接暂时无法获取。") from exc


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
