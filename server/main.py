from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import httpx
import imagehash
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from faster_whisper import WhisperModel
from PIL import Image
from pydantic import BaseModel, Field

app = FastAPI(title="Vid2Deck API")

allowed_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "1024"))

_whisper_model: WhisperModel | None = None


class SummarizeRequest(BaseModel):
    transcript: str = Field(min_length=1)


class SummarizeResponse(BaseModel):
    summary: str


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/api/summarize", response_model=SummarizeResponse)
async def summarize(request: SummarizeRequest) -> SummarizeResponse:
    return SummarizeResponse(summary=await summarize_with_deepseek(request.transcript))


@app.post("/api/process")
async def process_video(
    video: UploadFile = File(...),
    sample_every: float = Form(2.0),
    threshold: int = Form(8),
    min_gap: float = Form(3.0),
) -> FileResponse:
    if sample_every <= 0:
        raise HTTPException(status_code=400, detail="sample_every must be positive")
    if threshold < 0:
        raise HTTPException(status_code=400, detail="threshold must be non-negative")

    workdir = Path(tempfile.mkdtemp(prefix="vid2deck-"))
    try:
        input_path = workdir / safe_filename(video.filename or "upload.video")
        size = 0
        with input_path.open("wb") as out:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    raise HTTPException(status_code=413, detail=f"File is larger than {MAX_UPLOAD_MB} MB")
                out.write(chunk)

        frames_dir = workdir / "frames"
        unique_dir = workdir / "unique"
        frames_dir.mkdir()
        unique_dir.mkdir()

        extract_frames(input_path, frames_dir, sample_every)
        kept = dedupe_frames(frames_dir, unique_dir, threshold, min_gap, sample_every)
        pdf_path = workdir / "slides.pdf"
        make_pdf([item["path"] for item in kept], pdf_path)

        transcript = transcribe(input_path)
        transcript_path = workdir / "transcript.txt"
        transcript_path.write_text(transcript, encoding="utf-8")

        summary = await summarize_with_deepseek(transcript) if transcript.strip() else ""
        summary_path = workdir / "summary.md"
        summary_path.write_text(summary, encoding="utf-8")

        metadata_path = workdir / "metadata.json"
        metadata_path.write_text(json.dumps({
            "source_filename": video.filename,
            "sample_every": sample_every,
            "threshold": threshold,
            "min_gap": min_gap,
            "kept_slides": [
                {"index": i + 1, "time_seconds": item["time"], "file": item["path"].name}
                for i, item in enumerate(kept)
            ],
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        zip_path = workdir / "vid2deck-output.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(pdf_path, "slides.pdf")
            zf.write(transcript_path, "transcript.txt")
            zf.write(summary_path, "summary.md")
            zf.write(metadata_path, "metadata.json")
            for item in kept:
                zf.write(item["path"], f"slides/{item['path'].name}")

        return FileResponse(zip_path, filename="vid2deck-output.zip", media_type="application/zip")
    except HTTPException:
        raise
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {exc.stderr[-2000:] if exc.stderr else exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def safe_filename(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in name)[:180]


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def extract_frames(input_path: Path, frames_dir: Path, sample_every: float) -> None:
    fps = 1.0 / sample_every
    run([
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(input_path),
        "-vf",
        f"fps={fps}",
        "-q:v",
        "2",
        str(frames_dir / "frame_%06d.jpg"),
    ])


def dedupe_frames(frames_dir: Path, unique_dir: Path, threshold: int, min_gap: float, sample_every: float) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for index, frame_path in enumerate(sorted(frames_dir.glob("*.jpg"))):
        time_seconds = index * sample_every
        image_hash = imagehash.phash(Image.open(frame_path).convert("RGB"), hash_size=12)
        duplicate = False
        for item in kept:
            if abs(item["time"] - time_seconds) < min_gap:
                duplicate = True
                break
            if image_hash - item["hash"] <= threshold:
                duplicate = True
                break
        if duplicate:
            continue
        output_path = unique_dir / f"slide_{len(kept) + 1:04d}.jpg"
        shutil.copy2(frame_path, output_path)
        kept.append({"time": time_seconds, "hash": image_hash, "path": output_path})
    return kept


def make_pdf(image_paths: list[Path], output_path: Path) -> None:
    if not image_paths:
        raise ValueError("No unique frames were found")
    images = [Image.open(path).convert("RGB") for path in image_paths]
    first, rest = images[0], images[1:]
    first.save(output_path, save_all=True, append_images=rest)


def get_whisper_model() -> WhisperModel:
    global _whisper_model
    if _whisper_model is None:
        device = os.getenv("WHISPER_DEVICE", "cpu")
        compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        _whisper_model = WhisperModel(WHISPER_MODEL, device=device, compute_type=compute_type)
    return _whisper_model


def transcribe(input_path: Path) -> str:
    model = get_whisper_model()
    segments, info = model.transcribe(str(input_path), vad_filter=True, beam_size=5)
    lines = []
    for segment in segments:
        lines.append(f"[{format_ts(segment.start)} --> {format_ts(segment.end)}] {segment.text.strip()}")
    return "\n".join(lines).strip()


def format_ts(seconds: float) -> str:
    total = int(seconds)
    hh = total // 3600
    mm = (total % 3600) // 60
    ss = total % 60
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


async def summarize_with_deepseek(transcript: str) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="DEEPSEEK_API_KEY is not configured")

    prompt = f"""
请基于下面的视频逐字稿生成结构化中文 summary。
要求：
1. 先给 5-10 条要点。
2. 再按主题分段总结。
3. 最后列出可能的行动项、待确认问题和关键词。
4. 不要编造逐字稿中没有的信息。

逐字稿：
{transcript[:60000]}
""".strip()

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": "你是一个严谨的课程/会议视频总结助手。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            DEEPSEEK_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"DeepSeek API error: {response.text[:1000]}")
    data = response.json()
    return data["choices"][0]["message"]["content"].strip()
