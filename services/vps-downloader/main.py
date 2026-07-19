from __future__ import annotations

import asyncio
import hmac
import mimetypes
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yt_dlp
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from core import (
    DownloadProblem,
    ascii_filename,
    clean_error,
    download_size_limit,
    find_downloaded_media,
    friendly_youtube_error,
    normalize_youtube_url,
    positive_integer,
    safe_filename,
    valid_download_signature,
    youtube_cookie_file_content,
)


DEFAULT_FORMAT = (
    "best[height<=720][ext=mp4][vcodec!=none][acodec!=none]/"
    "best[height<=720][vcodec!=none][acodec!=none]/"
    "best[ext=mp4][vcodec!=none][acodec!=none]/best"
)
COOKIE_PLAYER_CLIENTS = "web_safari,mweb,tv"
MAX_ACTIVE_DOWNLOADS = positive_integer(os.getenv("MAX_ACTIVE_DOWNLOADS"), 2)
DOWNLOAD_SEMAPHORE = asyncio.Semaphore(MAX_ACTIVE_DOWNLOADS)

app = FastAPI(
    docs_url=None,
    redoc_url=None,
    title="Vid2PPT VPS downloader",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "https://vid2ppt.com,https://www.vid2ppt.com",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=[
        "Content-Disposition",
        "Content-Length",
        "X-Downloader-Engine",
        "X-Estimated-Bytes",
        "X-Filename",
    ],
    max_age=600,
)


class DownloadPayload(BaseModel):
    url: str
    rightsConfirmed: bool = False


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    engine: str


@app.get("/health")
async def health() -> dict[str, object]:
    max_download_mb, _ = download_size_limit()
    return {
        "ok": True,
        "engine": "yt-dlp",
        "maxActiveDownloads": MAX_ACTIVE_DOWNLOADS,
        "maxDownloadMb": max_download_mb,
    }


@app.post("/download")
async def download(
    payload: DownloadPayload,
    authorization: str | None = Header(default=None),
    expires: int | None = None,
    signature: str | None = None,
) -> FileResponse | JSONResponse:
    try:
        url = normalize_youtube_url(payload.url)
    except DownloadProblem as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    authorize(authorization, expires, signature, url)

    try:
        await asyncio.wait_for(DOWNLOAD_SEMAPHORE.acquire(), timeout=5)
    except asyncio.TimeoutError:
        return JSONResponse({"detail": "下载服务正忙，请稍后重试。"}, status_code=429)

    try:
        result = await asyncio.to_thread(download_with_fallbacks, url)
    except DownloadProblem as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except Exception as exc:
        print(f"vps-downloader: {clean_error(exc)}", flush=True)
        return JSONResponse({"detail": "VPS 下载服务暂时没有返回视频。"}, status_code=502)
    finally:
        DOWNLOAD_SEMAPHORE.release()

    path = result.path
    filename = safe_filename(path.name)
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        headers={
            "Cache-Control": "no-store",
            "X-Downloader-Engine": result.engine,
            "X-Estimated-Bytes": str(path.stat().st_size),
            "X-Filename": ascii_filename(filename),
        },
        background=BackgroundTask(shutil.rmtree, path.parent, True),
    )


def authorize(
    authorization: str | None,
    expires: int | None,
    signature: str | None,
    canonical_url: str,
) -> None:
    expected = (os.getenv("DOWNLOADER_API_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="下载服务尚未配置鉴权。")
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() == "bearer" and supplied and hmac.compare_digest(supplied, expected):
        return
    if valid_download_signature(expected, expires, signature, canonical_url):
        return
    raise HTTPException(status_code=401, detail="未授权。", headers={"WWW-Authenticate": "Bearer"})


def download_with_fallbacks(url: str) -> DownloadResult:
    try:
        return DownloadResult(download_youtube(url), "vps-ytdlp")
    except DownloadProblem as primary_error:
        if "超过" in str(primary_error):
            raise
        if not henghengmao_is_configured():
            raise
        print(f"vps-ytdlp failed, trying henghengmao: {clean_error(primary_error)}", flush=True)

    try:
        from henghengmao import download_with_henghengmao

        _, max_download_bytes = download_size_limit()
        return DownloadResult(
            download_with_henghengmao(url, max_download_bytes=max_download_bytes),
            "vps-henghengmao",
        )
    except Exception as fallback_error:
        print(f"henghengmao failed: {clean_error(fallback_error)}", flush=True)
        raise DownloadProblem("固定 IP 与哼哼猫均未获取到这个 YouTube 视频，请稍后重试。") from fallback_error


def henghengmao_is_configured() -> bool:
    return bool(
        (os.getenv("HENGHENGMAO_USERNAME") or "").strip()
        and (os.getenv("HENGHENGMAO_PASSWORD") or "").strip()
    )


def download_youtube(url: str) -> Path:
    max_download_mb, max_download_bytes = download_size_limit()
    cookie_text = youtube_cookie_file_content()
    attempts = [False, True] if cookie_text else [False]
    messages: list[str] = []

    for use_cookies in attempts:
        tempdir = Path(tempfile.mkdtemp(prefix="vid2ppt-vps-download-"))
        try:
            return download_once(
                url,
                tempdir=tempdir,
                cookie_text=cookie_text if use_cookies else "",
                max_download_bytes=max_download_bytes,
                max_download_mb=max_download_mb,
            )
        except DownloadProblem as exc:
            shutil.rmtree(tempdir, ignore_errors=True)
            if "超过" in str(exc) or "Download exceeded" in str(exc):
                raise DownloadProblem(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。") from exc
            messages.append(clean_error(exc))
        except Exception as exc:
            messages.append(clean_error(exc))
            shutil.rmtree(tempdir, ignore_errors=True)

    raise DownloadProblem(friendly_youtube_error(messages, max_download_mb, bool(cookie_text)))


def download_once(
    url: str,
    *,
    tempdir: Path,
    cookie_text: str,
    max_download_bytes: int,
    max_download_mb: int,
) -> Path:
    def progress_hook(status: dict[str, Any]) -> None:
        total = int(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)
        downloaded = int(status.get("downloaded_bytes") or 0)
        if max(total, downloaded) > max_download_bytes:
            raise DownloadProblem(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。")

    ydl_options: dict[str, Any] = {
        "cachedir": False,
        "concurrent_fragment_downloads": 4,
        "format": os.getenv("VID2PPT_CLOUD_YTDLP_FORMAT", DEFAULT_FORMAT),
        "fragment_retries": 3,
        "js_runtimes": {"deno": {}},
        "max_filesize": max_download_bytes,
        "merge_output_format": "mp4",
        "noplaylist": True,
        "no_warnings": True,
        "outtmpl": str(tempdir / "%(title).160B-%(id)s.%(ext)s"),
        "progress_hooks": [progress_hook],
        "quiet": True,
        "remote_components": {"ejs:github"},
        "retries": 3,
        "socket_timeout": 30,
        "windowsfilenames": True,
    }

    player_clients = [
        item.strip()
        for item in os.getenv(
            "VID2PPT_YOUTUBE_PLAYER_CLIENTS",
            COOKIE_PLAYER_CLIENTS if cookie_text else "",
        ).split(",")
        if item.strip()
    ]
    if player_clients:
        ydl_options["extractor_args"] = {"youtube": {"player_client": player_clients}}
    if cookie_text:
        cookie_path = tempdir / "youtube-cookies.txt"
        cookie_path.write_text(cookie_text, encoding="utf-8")
        ydl_options["cookiefile"] = str(cookie_path)

    with yt_dlp.YoutubeDL(ydl_options) as downloader:
        downloader.extract_info(url, download=True)

    media = find_downloaded_media(tempdir)
    if media.stat().st_size > max_download_bytes:
        raise DownloadProblem(f"视频文件超过 {max_download_mb} MB，请换短视频或先裁剪。")
    return media
