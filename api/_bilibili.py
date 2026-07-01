from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import yt_dlp


DEFAULT_BILIBILI_FORMAT = (
    "best[height<=720][vcodec!=none][acodec!=none]/"
    "bestvideo[height<=720][ext=mp4]/"
    "bestvideo[height<=720]/"
    "best[height<=720]/best"
)
BILIBILI_MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".flv", ".m4a", ".mp3", ".aac"}
BILIBILI_PAGE_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}
BILIBILI_SHORT_HOSTS = {"b23.tv"}
BILIBILI_ALLOWED_HOST_SUFFIXES = (".bilibili.com",)


class BilibiliError(Exception):
    pass


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def is_bilibili_url(raw_url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(raw_url)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return host in BILIBILI_PAGE_HOSTS or host in BILIBILI_SHORT_HOSTS or host.endswith(BILIBILI_ALLOWED_HOST_SUFFIXES)


def canonicalize_bilibili_url(raw_url: str) -> str:
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise BilibiliError("请输入有效的 B 站视频链接。")

    host = parsed.hostname.lower()
    if host in BILIBILI_SHORT_HOSTS:
        return resolve_bilibili_short_url(raw_url)
    if not is_bilibili_url(raw_url):
        raise BilibiliError("请输入 bilibili.com 或 b23.tv 视频链接。")
    return urllib.parse.urlunparse(parsed._replace(scheme="https", fragment=""))


def resolve_bilibili_short_url(raw_url: str) -> str:
    opener = urllib.request.build_opener(NoRedirectHandler)
    current = raw_url
    for _ in range(5):
        parsed = urllib.parse.urlparse(current)
        host = (parsed.hostname or "").lower()
        if host not in BILIBILI_SHORT_HOSTS and not is_bilibili_url(current):
            raise BilibiliError("B 站短链跳转到了不支持的地址。")

        request = urllib.request.Request(
            urllib.parse.urlunparse(parsed._replace(scheme="https")),
            method="GET",
            headers=bilibili_request_headers(),
        )
        try:
            with opener.open(request, timeout=12) as response:
                final_url = response.geturl()
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                location = exc.headers.get("Location")
                if not location:
                    raise BilibiliError("B 站短链缺少跳转地址。") from exc
                current = urllib.parse.urljoin(current, location)
                if is_resolved_bilibili_video_url(current):
                    return urllib.parse.urlunparse(urllib.parse.urlparse(current)._replace(scheme="https", fragment=""))
                continue
            raise BilibiliError("无法解析这个 B 站短链。") from exc
        except Exception as exc:
            raise BilibiliError("无法解析这个 B 站短链。") from exc

        if is_resolved_bilibili_video_url(final_url):
            return urllib.parse.urlunparse(urllib.parse.urlparse(final_url)._replace(scheme="https", fragment=""))
        current = final_url

    raise BilibiliError("B 站短链重定向次数过多。")


def is_resolved_bilibili_video_url(raw_url: str) -> bool:
    parsed = urllib.parse.urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    return is_bilibili_url(raw_url) and host not in BILIBILI_SHORT_HOSTS


def get_bilibili_metadata(raw_url: str) -> dict[str, Any]:
    canonical_url = canonicalize_bilibili_url(raw_url)
    try:
        with tempfile.TemporaryDirectory(prefix="vid2ppt-bilibili-metadata-") as tempdir_name:
            tempdir = Path(tempdir_name)
            opts = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "noplaylist": True,
                "cachedir": False,
                "socket_timeout": 20,
                "http_headers": bilibili_request_headers(canonical_url),
            }
            if cookiefile := write_bilibili_cookie_file(tempdir):
                opts["cookiefile"] = str(cookiefile)
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(canonical_url, download=False)
    except Exception as exc:
        raise BilibiliError(bilibili_error_message(str(exc))) from exc

    if not isinstance(info, dict):
        raise BilibiliError("B 站没有返回可识别的视频信息。")

    title = text_value(info.get("title")) or "Bilibili 视频"
    uploader = text_value(info.get("uploader") or info.get("channel") or info.get("creator"))
    thumbnail = text_value(info.get("thumbnail"))
    duration = number_value(info.get("duration"))
    webpage_url = text_value(info.get("webpage_url")) or canonical_url
    formats = info.get("formats") if isinstance(info.get("formats"), list) else []

    return {
        "sourceType": "url",
        "provider": "bilibili",
        "url": sanitize_url(webpage_url),
        "finalUrl": sanitize_url(canonical_url),
        "title": title,
        "authorName": uploader,
        "thumbnailUrl": thumbnail,
        "durationSeconds": duration,
        "downloadable": True,
        "formatCount": len(formats),
        "allowedActions": ["metadata", "download", "transcode", "thumbnail"],
        "policy": {
            "downloadAllowed": True,
            "reason": "B 站视频会在服务端获取并加入队列；处理前需要确认你有权保存、转换或分析该内容。",
        },
    }


def download_bilibili_video(raw_url: str, *, max_download_bytes: int) -> Path:
    canonical_url = canonicalize_bilibili_url(raw_url)
    tempdir = Path(tempfile.mkdtemp(prefix="vid2ppt-bilibili-download-"))
    outtmpl = str(tempdir / "%(title).160B-%(id)s.%(ext)s")
    opts = {
        "outtmpl": outtmpl,
        "format": os.getenv("VID2PPT_BILIBILI_YTDLP_FORMAT", DEFAULT_BILIBILI_FORMAT),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
        "max_filesize": max_download_bytes,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "cachedir": False,
        "http_headers": bilibili_request_headers(canonical_url),
    }
    if cookiefile := write_bilibili_cookie_file(tempdir):
        opts["cookiefile"] = str(cookiefile)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(canonical_url, download=True)
        media = find_downloaded_media(tempdir)
        if media.stat().st_size > max_download_bytes:
            raise BilibiliError("B 站视频文件超过当前下载大小限制，请换短视频或先裁剪。")
        return media
    except BilibiliError:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise BilibiliError(bilibili_error_message(str(exc))) from exc


def bilibili_request_headers(referer_url: str = "https://www.bilibili.com/") -> dict[str, str]:
    headers = {
        "Accept": "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": referer_url if referer_url.startswith("http") else "https://www.bilibili.com/",
        "User-Agent": os.getenv(
            "VID2PPT_BILIBILI_USER_AGENT",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ),
    }
    cookie = bilibili_cookie_header()
    if cookie:
        headers["Cookie"] = cookie
    return headers


def bilibili_cookie_header() -> str:
    raw_cookie = (os.getenv("BILIBILI_COOKIE") or os.getenv("BILIBILI_COOKIES") or "").strip()
    if raw_cookie:
        return raw_cookie

    pieces: list[str] = []
    cookie_env_map = {
        "SESSDATA": "BILIBILI_SESSDATA",
        "bili_jct": "BILIBILI_BILI_JCT",
        "DedeUserID": "BILIBILI_DEDEUSERID",
        "DedeUserID__ckMd5": "BILIBILI_DEDEUSERID_CKMD5",
        "sid": "BILIBILI_SID",
    }
    for cookie_name, env_name in cookie_env_map.items():
        value = (os.getenv(env_name) or "").strip()
        if value:
            pieces.append(f"{cookie_name}={value}")
    return "; ".join(pieces)


def write_bilibili_cookie_file(directory: Path) -> Path | None:
    pairs = bilibili_cookie_pairs()
    if not pairs:
        return None
    expires = int(time.time()) + 180 * 24 * 60 * 60
    lines = ["# Netscape HTTP Cookie File", ""]
    for name, value in pairs:
        lines.append(f".bilibili.com\tTRUE\t/\tTRUE\t{expires}\t{name}\t{value}")
    path = directory / "bilibili-cookies.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def bilibili_cookie_pairs() -> list[tuple[str, str]]:
    header = bilibili_cookie_header()
    if not header:
        return []
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in header.split(";"):
        name, sep, value = item.strip().partition("=")
        if sep and name and name not in seen:
            pairs.append((name, value))
            seen.add(name)
    return pairs


def find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in BILIBILI_MEDIA_SUFFIXES and not path.name.endswith(".part")
    ]
    if not candidates:
        raise BilibiliError("没有获取到可处理的 B 站视频文件。")
    return max(candidates, key=lambda item: item.stat().st_size)


def bilibili_error_message(message: str) -> str:
    cleaned = clean_error(message)
    lowered = cleaned.lower()
    if "requested format is not available" in lowered:
        return "这个 B 站视频暂时没有可直接处理的视频格式。"
    if "file is larger than max-filesize" in lowered:
        return "B 站视频文件超过当前下载大小限制，请换短视频或先裁剪。"
    if "http error 412" in lowered or "precondition failed" in lowered:
        if bilibili_cookie_header():
            return "B 站仍拒绝了 Vercel 云端请求；服务端 Cookie 已配置，但这个请求被 B 站返回 412。"
        return "B 站拒绝了云端匿名请求。请在 Vercel 项目配置 BILIBILI_COOKIE 或 BILIBILI_SESSDATA 后再试。"
    if any(token in lowered for token in ("login", "cookie", "sessdata", "credential")) or "登录" in cleaned:
        return "这个 B 站视频需要登录权限。请在服务端配置 BILIBILI_COOKIE 或 BILIBILI_SESSDATA 后再试。"
    if any(token in cleaned for token in ("大会员", "权限", "付费", "地区", "版权")):
        return "B 站返回了访问限制，请确认服务端账号可以正常播放这个视频。"
    return cleaned or "这个 B 站链接暂时无法获取。"


def sanitize_url(raw_url: str) -> str:
    parsed = urllib.parse.urlparse(raw_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted = [
        (key, "[redacted]" if any(token in key.lower() for token in ("token", "signature", "sig", "key", "auth", "credential", "expires")) else value)
        for key, value in query
    ]
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(redacted), fragment=""))


def text_value(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def number_value(value: Any) -> int | None:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def clean_error(message: str) -> str:
    message = re.sub(r"\x1b\[[0-9;]*m", "", message)
    message = message.replace("ERROR:", "")
    try:
        payload = json.loads(message)
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload.get("detail") or message)
    except Exception:
        pass
    return re.sub(r"\s+", " ", message).strip()
