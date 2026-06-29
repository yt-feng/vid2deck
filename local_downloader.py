from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import yt_dlp
except ModuleNotFoundError:
    yt_dlp = None  # type: ignore[assignment]


SERVICE_NAME = "vid2ppt-local-downloader"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 32 * 1024
DEFAULT_MAX_DOWNLOAD_MB = 2048
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_ALLOWED_ORIGINS = {
    "https://vid2ppt.com",
    "https://www.vid2ppt.com",
    "https://vid2deck.vercel.app",
}
MEDIA_SUFFIXES = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".wav", ".opus"}
JOB_TTL_SECONDS = 60 * 30
JOBS_LOCK = threading.Lock()
JOBS: dict[str, dict[str, Any]] = {}


class LocalDownloaderHandler(BaseHTTPRequestHandler):
    server_version = f"{SERVICE_NAME}/1.0"

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._json({"detail": "Origin is not allowed."}, status=403)
            return
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path_only == "/health":
            if not self._origin_allowed():
                self._json({"detail": "Origin is not allowed."}, status=403)
                return
            if yt_dlp is None:
                self._json({"ok": False, "service": SERVICE_NAME, "detail": "视频链接功能尚未安装。"}, status=500)
                return
            self._json({"ok": True, "service": SERVICE_NAME, "version": yt_dlp.version.__version__})
            return

        if self.path_only.startswith("/download/status/"):
            if not self._origin_allowed():
                self._json({"detail": "Origin is not allowed."}, status=403)
                return
            cleanup_expired_jobs()
            job_id = self.path_only.rsplit("/", 1)[-1]
            job = get_job(job_id)
            if not job:
                self._json({"detail": "Download job was not found."}, status=404)
                return
            self._json(public_job(job))
            return

        if self.path_only.startswith("/download/file/"):
            if not self._origin_allowed():
                self._json({"detail": "Origin is not allowed."}, status=403)
                return
            cleanup_expired_jobs()
            job_id = self.path_only.rsplit("/", 1)[-1]
            job = get_job(job_id)
            if not job:
                self._json({"detail": "Download job was not found."}, status=404)
                return
            if job.get("status") != "finished" or not job.get("path"):
                self._json({"detail": "Download is not ready yet."}, status=409)
                return
            path = Path(str(job["path"]))
            if not path.exists():
                self._json({"detail": "Downloaded file is no longer available."}, status=410)
                delete_job(job_id)
                return
            try:
                self._send_file(path)
            finally:
                remove_job_files(job)
                delete_job(job_id)
            return
        self._json({"detail": "Not found."}, status=404)

    def do_POST(self) -> None:
        if self.path_only == "/download/start":
            if not self._origin_allowed():
                self._json({"detail": "Origin is not allowed."}, status=403)
                return
            if yt_dlp is None:
                self._json({"detail": "视频链接功能尚未安装，请更新或重新安装 Vid2PPT 本地版。"}, status=500)
                return
            try:
                payload = self._read_json()
                url = validate_url(str(payload.get("url", "")).strip())
                job = create_job(url)
                thread = threading.Thread(target=run_download_job, args=(job["id"], url), daemon=True)
                thread.start()
                self._json(public_job(job), status=202)
            except DownloadError as exc:
                self._json({"detail": str(exc)}, status=400)
            except Exception as exc:
                self._json({"detail": clean_error(str(exc)) or "Download failed."}, status=500)
            return

        if self.path_only != "/download":
            self._json({"detail": "Not found."}, status=404)
            return
        if not self._origin_allowed():
            self._json({"detail": "Origin is not allowed."}, status=403)
            return
        if yt_dlp is None:
            self._json({"detail": "视频链接功能尚未安装，请更新或重新安装 Vid2PPT 本地版。"}, status=500)
            return

        try:
            payload = self._read_json()
            url = validate_url(str(payload.get("url", "")).strip())
            downloaded = download_with_ytdlp(url)
            try:
                self._send_file(downloaded)
            finally:
                shutil.rmtree(downloaded.parent, ignore_errors=True)
        except DownloadError as exc:
            self._json({"detail": str(exc)}, status=400)
        except Exception as exc:
            self._json({"detail": clean_error(str(exc)) or "Download failed."}, status=500)

    @property
    def path_only(self) -> str:
        return urllib.parse.urlparse(self.path).path

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise DownloadError("Invalid request body.") from exc
        if length <= 0 or length > MAX_BODY_BYTES:
            raise DownloadError("Invalid request body size.")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise DownloadError("Request body must be JSON.") from exc
        if not isinstance(data, dict):
            raise DownloadError("Request body must be a JSON object.")
        return data

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin == "null":
            return os.getenv("VID2PPT_ALLOW_NULL_ORIGIN", "").lower() in {"1", "true", "yes"}
        parsed = urllib.parse.urlparse(origin)
        if parsed.scheme in {"http", "https"} and parsed.hostname in LOCAL_HOSTS:
            return True
        return origin in allowed_origins()

    def _send_cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed() and origin != "null":
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-Filename")

    def _json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        filename = safe_filename(path.name)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", content_disposition(filename))
        self.send_header("X-Filename", ascii_filename(filename))
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, length=1024 * 1024)

    def log_message(self, format: str, *args: Any) -> None:
        if os.getenv("VID2PPT_LOCAL_DOWNLOADER_QUIET", "").lower() in {"1", "true", "yes"}:
            return
        super().log_message(format, *args)


class DownloadError(Exception):
    pass


def create_job(url: str) -> dict[str, Any]:
    now = time.time()
    job = {
        "id": uuid.uuid4().hex,
        "url": url,
        "status": "queued",
        "progress": 0,
        "message": "等待开始",
        "created_at": now,
        "updated_at": now,
    }
    with JOBS_LOCK:
        JOBS[job["id"]] = job
    return dict(job)


def get_job(job_id: str) -> dict[str, Any] | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def update_job(job_id: str, **changes: Any) -> dict[str, Any] | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        job.update(changes)
        job["updated_at"] = time.time()
        return dict(job)


def delete_job(job_id: str) -> None:
    with JOBS_LOCK:
        JOBS.pop(job_id, None)


def cleanup_expired_jobs() -> None:
    now = time.time()
    expired: list[dict[str, Any]] = []
    with JOBS_LOCK:
        for job_id, job in list(JOBS.items()):
            if now - float(job.get("updated_at", now)) > JOB_TTL_SECONDS:
                expired.append(dict(job))
                JOBS.pop(job_id, None)
    for job in expired:
        remove_job_files(job)


def remove_job_files(job: dict[str, Any]) -> None:
    path_value = job.get("path")
    if not path_value:
        return
    try:
        shutil.rmtree(Path(str(path_value)).parent, ignore_errors=True)
    except Exception:
        pass


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    data = {
        "id": job.get("id", ""),
        "status": job.get("status", "queued"),
        "progress": round(float(job.get("progress", 0)), 1),
        "message": job.get("message", ""),
        "filename": job.get("filename", ""),
        "downloaded_bytes": int(job.get("downloaded_bytes", 0) or 0),
        "total_bytes": int(job.get("total_bytes", 0) or 0),
    }
    if job.get("error"):
        data["error"] = str(job["error"])
    return data


def run_download_job(job_id: str, url: str) -> None:
    update_job(job_id, status="downloading", progress=1, message="正在解析链接")

    def progress_hook(event: dict[str, Any]) -> None:
        status = event.get("status")
        if status == "downloading":
            downloaded = int(event.get("downloaded_bytes") or 0)
            total = int(event.get("total_bytes") or event.get("total_bytes_estimate") or 0)
            progress = 5.0
            if total > 0:
                progress = min(92.0, max(5.0, downloaded / total * 92.0))
            update_job(
                job_id,
                status="downloading",
                progress=progress,
                message="正在下载视频",
                downloaded_bytes=downloaded,
                total_bytes=total,
            )
        elif status == "finished":
            update_job(job_id, status="downloading", progress=92, message="正在整理视频")

    try:
        media = download_with_ytdlp(url, progress_hook=progress_hook)
        update_job(
            job_id,
            status="finished",
            progress=92,
            message="视频已获取，正在导入",
            path=str(media),
            filename=safe_filename(media.name),
            downloaded_bytes=media.stat().st_size,
            total_bytes=media.stat().st_size,
        )
    except Exception as exc:
        update_job(
            job_id,
            status="error",
            progress=100,
            message="获取失败",
            error=clean_error(str(exc)) or "Download failed.",
        )


def allowed_origins() -> set[str]:
    configured = os.getenv("VID2PPT_ALLOWED_ORIGINS", "")
    if not configured.strip():
        return DEFAULT_ALLOWED_ORIGINS
    return {origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()}


def validate_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise DownloadError("Please provide a valid http or https video URL.")
    return value


def download_with_ytdlp(url: str, progress_hook: Any | None = None) -> Path:
    max_download_mb = int(os.getenv("VID2PPT_MAX_DOWNLOAD_MB", str(DEFAULT_MAX_DOWNLOAD_MB)))
    max_download_bytes = max(1, max_download_mb) * 1024 * 1024
    tempdir = Path(tempfile.mkdtemp(prefix="vid2ppt-download-"))
    outtmpl = str(tempdir / "%(title).180B-%(id)s.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": os.getenv("VID2PPT_YTDLP_FORMAT", "best[height<=1080]/bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best"),
        "merge_output_format": os.getenv("VID2PPT_MERGE_FORMAT", "mp4"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "windowsfilenames": True,
        "max_filesize": max_download_bytes,
        "retries": 3,
        "fragment_retries": 3,
        "cachedir": False,
    }
    if progress_hook:
        ydl_opts["progress_hooks"] = [progress_hook]
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:  # type: ignore[union-attr]
            ydl.extract_info(url, download=True)
        media = find_downloaded_media(tempdir)
        if media.stat().st_size > max_download_bytes:
            raise DownloadError(f"Downloaded file is larger than {max_download_mb} MB.")
        return media
    except DownloadError:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise DownloadError(clean_error(str(exc)) or "这个链接暂时无法获取。") from exc


def find_downloaded_media(directory: Path) -> Path:
    candidates = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in MEDIA_SUFFIXES and not path.name.endswith(".part")
    ]
    if not candidates:
        raise DownloadError("No downloadable media file was produced.")
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


def main() -> None:
    host = os.getenv("VID2PPT_LOCAL_DOWNLOADER_HOST", DEFAULT_HOST)
    port = int(os.getenv("VID2PPT_LOCAL_DOWNLOADER_PORT", str(DEFAULT_PORT)))
    server = ThreadingHTTPServer((host, port), LocalDownloaderHandler)
    print(f"{SERVICE_NAME} listening on http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local downloader.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
