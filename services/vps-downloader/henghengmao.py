from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse


HOME_URL = "https://www.henghengmao.com/en"
DESKTOP_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
HENGHENGMAO_LOCK = threading.Lock()


class HenghengmaoError(Exception):
    pass


def download_with_henghengmao(url: str, *, max_download_bytes: int) -> Path:
    username = (os.getenv("HENGHENGMAO_USERNAME") or "").strip()
    password = (os.getenv("HENGHENGMAO_PASSWORD") or "").strip()
    if not username or not password:
        raise HenghengmaoError("哼哼猫账号未配置。")

    try:
        import httpx
        from playwright.sync_api import TimeoutError as PlaywrightTimeout
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise HenghengmaoError("哼哼猫浏览器组件未安装。") from exc

    profile_dir = Path(os.getenv("HENGHENGMAO_PROFILE_DIR", "/data/henghengmao-profile"))
    profile_dir.mkdir(parents=True, exist_ok=True)
    tempdir = Path(tempfile.mkdtemp(prefix="vid2ppt-henghengmao-"))

    try:
        with HENGHENGMAO_LOCK, sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile_dir),
                accept_downloads=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
                headless=True,
                user_agent=DESKTOP_UA,
                viewport={"width": 1440, "height": 900},
            )
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(HOME_URL, wait_until="domcontentloaded", timeout=45_000)
                page.wait_for_timeout(1_500)
                ensure_logged_in(page, username, password, PlaywrightTimeout)

                box = page.locator("input[placeholder*='Paste a post share link']")
                box.wait_for(state="visible", timeout=20_000)
                box.fill(url, timeout=20_000)
                page.get_by_role("button", name="Download", exact=True).first.click(timeout=20_000)
                try:
                    page.wait_for_selector("a:has-text('Download Video')", timeout=75_000)
                except PlaywrightTimeout as exc:
                    raise HenghengmaoError("哼哼猫没有解析出视频下载链接。") from exc

                link = page.get_by_text("Download Video", exact=True).first
                href = link.get_attribute("href")
                if not href or not href.startswith(("http://", "https://")):
                    raise HenghengmaoError("哼哼猫返回了无效的视频地址。")

                destination = tempdir / media_filename(url, href)
                cookies = {item["name"]: item["value"] for item in context.cookies()}
                try:
                    download_direct(
                        httpx,
                        href,
                        destination,
                        cookies=cookies,
                        max_download_bytes=max_download_bytes,
                    )
                except Exception as direct_error:
                    response = context.request.get(
                        href,
                        headers={"Referer": HOME_URL, "User-Agent": DESKTOP_UA},
                        timeout=300_000,
                    )
                    if response.status >= 400:
                        raise HenghengmaoError(
                            f"哼哼猫视频地址返回 HTTP {response.status}。"
                        ) from direct_error
                    content = response.body()
                    if not content:
                        raise HenghengmaoError("哼哼猫返回了空视频。") from direct_error
                    if len(content) > max_download_bytes:
                        raise HenghengmaoError("哼哼猫返回的视频超过大小限制。") from direct_error
                    destination.write_bytes(content)
            finally:
                context.close()
    except Exception:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise

    if not destination.exists() or destination.stat().st_size <= 0:
        shutil.rmtree(tempdir, ignore_errors=True)
        raise HenghengmaoError("哼哼猫没有下载到视频文件。")
    return destination


def ensure_logged_in(page, username: str, password: str, timeout_error) -> None:
    login_button = page.get_by_text("Log in/Sign up", exact=True)
    if login_button.count() == 0 or not login_button.first.is_visible():
        return
    login_button.first.click(timeout=15_000)
    page.locator("#username").fill(username, timeout=15_000)
    page.locator("#password").fill(password, timeout=15_000)
    page.locator("#password").press("Enter")
    try:
        login_button.first.wait_for(state="hidden", timeout=20_000)
    except timeout_error:
        pass
    page.wait_for_timeout(1_000)
    if login_button.count() and login_button.first.is_visible():
        raise HenghengmaoError("哼哼猫登录失败。")


def download_direct(
    httpx,
    url: str,
    destination: Path,
    *,
    cookies: dict[str, str],
    max_download_bytes: int,
) -> None:
    headers = {"Accept": "*/*", "Referer": HOME_URL, "User-Agent": DESKTOP_UA}
    written = 0
    partial = destination.with_suffix(destination.suffix + ".part")
    try:
        with httpx.Client(
            cookies=cookies,
            follow_redirects=True,
            timeout=httpx.Timeout(300, connect=30),
        ) as client:
            with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("content-length") or 0)
                if content_length > max_download_bytes:
                    raise HenghengmaoError("哼哼猫返回的视频超过大小限制。")
                with partial.open("wb") as handle:
                    for chunk in response.iter_bytes(1024 * 1024):
                        written += len(chunk)
                        if written > max_download_bytes:
                            raise HenghengmaoError("哼哼猫返回的视频超过大小限制。")
                        handle.write(chunk)
        partial.replace(destination)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def media_filename(source_url: str, media_url: str) -> str:
    digest = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:12]
    suffix = Path(urlparse(media_url).path).suffix.lower()
    if suffix not in {".m4v", ".mkv", ".mov", ".mp4", ".webm"}:
        suffix = ".mp4"
    return f"youtube-{digest}{suffix}"
