from __future__ import annotations

import ipaddress
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler
from typing import Any

try:
    from _bilibili import BilibiliError, get_bilibili_metadata, is_bilibili_url
except ModuleNotFoundError:
    from api._bilibili import BilibiliError, get_bilibili_metadata, is_bilibili_url


MEDIA_CONTENT_TYPES = ("audio/", "video/", "application/octet-stream")
BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}


class MediaMetadataError(Exception):
    def __init__(self, message: str, status: int = 400, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        self.send_json({"ok": True, "route": "/api/media/metadata", "method": "POST only"})

    def do_POST(self) -> None:
        try:
            data = self.read_json()
            source_type = str(data.get("sourceType", "url"))
            raw_url = str(data.get("url", "")).strip()
            if source_type != "url":
                raise MediaMetadataError("目前仅支持 URL 来源。")
            metadata = get_media_metadata(raw_url)
            self.send_json(metadata)
        except MediaMetadataError as exc:
            self.send_json({"error": exc.__class__.__name__, "message": str(exc), "details": exc.details}, exc.status)
        except Exception as exc:
            self.send_json({"error": "UpstreamError", "message": clean_error(str(exc)) or "暂时无法解析这个链接。"}, 500)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0 or length > 32 * 1024:
            raise MediaMetadataError("请输入有效的视频链接。")
        body = self.rfile.read(length).decode("utf-8")
        data = json.loads(body or "{}")
        if not isinstance(data, dict):
            raise MediaMetadataError("请输入有效的视频链接。")
        return data

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGINS", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def get_media_metadata(raw_url: str) -> dict[str, Any]:
    parsed = parse_http_url(raw_url)
    host = (parsed.hostname or "").lower()

    if "yt1s.com" in host:
        raise MediaMetadataError(
            "不支持把 yt1s 自动化成 Vid2PPT 的下载代理。",
            details={
                "provider": "yt1s",
                "allowedAlternatives": [
                    "youtube-oembed-metadata",
                    "screen-recording",
                    "user-upload",
                    "authorized-direct-media-url",
                ],
            },
        )

    if is_youtube_url(parsed):
        return youtube_oembed_metadata(raw_url)

    if is_bilibili_url(raw_url):
        try:
            return get_bilibili_metadata(raw_url)
        except BilibiliError as exc:
            raise MediaMetadataError(str(exc), 502, {"provider": "bilibili"}) from exc

    return direct_media_metadata(raw_url)


def youtube_oembed_metadata(raw_url: str) -> dict[str, Any]:
    request_url = "https://www.youtube.com/oembed?" + urllib.parse.urlencode({"url": raw_url, "format": "json"})
    request = urllib.request.Request(
        request_url,
        headers={"Accept": "application/json", "User-Agent": "Vid2PPTMediaIngestion/0.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise MediaMetadataError("YouTube 元数据请求失败。", 502, {"status": exc.code}) from exc
    except Exception as exc:
        raise MediaMetadataError("YouTube 元数据请求失败。", 502) from exc

    return {
        "sourceType": "url",
        "provider": "youtube-oembed",
        "url": raw_url,
        "title": payload.get("title"),
        "authorName": payload.get("author_name"),
        "authorUrl": payload.get("author_url"),
        "thumbnailUrl": payload.get("thumbnail_url"),
        "thumbnailWidth": payload.get("thumbnail_width"),
        "thumbnailHeight": payload.get("thumbnail_height"),
        "embedHtml": payload.get("html"),
        "downloadable": False,
        "allowedActions": ["metadata", "embed", "screen-recording", "user-upload"],
        "policy": {
            "downloadAllowed": False,
            "reason": "YouTube 来源在这个能力中仅用于元数据/嵌入预览；保存处理请使用录屏、用户上传或已授权直链。",
        },
    }


def direct_media_metadata(raw_url: str) -> dict[str, Any]:
    final_url, headers = probe_media_url(raw_url)
    content_type = headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    if not any(content_type.lower().startswith(prefix) for prefix in MEDIA_CONTENT_TYPES):
        raise MediaMetadataError("这个 URL 不像可直接读取的音视频文件。", details={"contentType": content_type})

    return {
        "sourceType": "url",
        "provider": "direct-media",
        "url": sanitize_url(raw_url),
        "finalUrl": sanitize_url(final_url),
        "contentType": content_type,
        "contentLength": headers.get("content-length"),
        "acceptsRanges": headers.get("accept-ranges", "").lower() == "bytes",
        "downloadable": True,
        "allowedActions": ["download", "transcode", "thumbnail"],
        "policy": {
            "downloadAllowed": True,
            "reason": "直链媒体通过了公网地址和内容类型检查，处理前仍需确认你有权保存或转换该媒体。",
        },
    }


def probe_media_url(raw_url: str, redirect_count: int = 0) -> tuple[str, dict[str, str]]:
    if redirect_count > 5:
        raise MediaMetadataError("链接重定向次数过多。")

    parsed = parse_public_fetchable_url(raw_url)
    request = urllib.request.Request(
        urllib.parse.urlunparse(parsed),
        method="HEAD",
        headers={"User-Agent": "Vid2PPTMediaIngestion/0.1"},
    )
    opener = urllib.request.build_opener(NoRedirectHandler)
    try:
        response = opener.open(request, timeout=12)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            location = exc.headers.get("Location")
            if not location:
                raise MediaMetadataError("重定向响应缺少 Location。", 502, {"status": exc.code}) from exc
            next_url = urllib.parse.urljoin(urllib.parse.urlunparse(parsed), location)
            return probe_media_url(next_url, redirect_count + 1)
        raise MediaMetadataError("媒体链接探测失败。", 502, {"status": exc.code}) from exc

    with response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        final_url = response.geturl()
    return final_url, headers


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def parse_public_fetchable_url(raw_url: str) -> urllib.parse.ParseResult:
    parsed = parse_http_url(raw_url)
    host = (parsed.hostname or "").lower()
    if host in BLOCKED_HOSTS or host.endswith(".local"):
        raise MediaMetadataError("这个 URL 主机不允许访问。", details={"host": host})
    if host_is_private(host):
        raise MediaMetadataError("这个 URL 指向内网或保留地址。", details={"host": host})
    return parsed


def parse_http_url(raw_url: str) -> urllib.parse.ParseResult:
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise MediaMetadataError("请输入有效的 http 或 https 视频链接。")
    if not parsed.hostname:
        raise MediaMetadataError("视频链接缺少主机名。")
    return parsed


def is_youtube_url(parsed: urllib.parse.ParseResult) -> bool:
    host = (parsed.hostname or "").lower()
    return (
        host == "youtube.com"
        or host.endswith(".youtube.com")
        or host == "youtu.be"
        or host == "youtube-nocookie.com"
        or host.endswith(".youtube-nocookie.com")
    )


def host_is_private(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        addresses = [(host,)]
    except ValueError:
        try:
            addresses = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        except socket.gaierror as exc:
            raise MediaMetadataError("无法解析这个链接。") from exc

    for item in addresses:
        address = item[0] if len(item) == 1 else item[4][0]
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return True
    return False


def sanitize_url(raw_url: str) -> str:
    parsed = urllib.parse.urlparse(raw_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted = [
        (key, "[redacted]" if any(token in key.lower() for token in ("token", "signature", "sig", "key", "auth", "credential", "expires")) else value)
        for key, value in query
    ]
    safe = parsed._replace(netloc=parsed.hostname or "", query=urllib.parse.urlencode(redacted))
    return urllib.parse.urlunparse(safe)


def clean_error(message: str) -> str:
    return " ".join(message.replace("ERROR:", "").split()).strip()
