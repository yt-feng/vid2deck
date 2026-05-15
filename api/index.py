from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Vid2Deck Summary API")

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
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
AUTH_CODE = os.getenv("AUTH_CODE", "")
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    access_code: str = Field(min_length=1)


class LoginResponse(BaseModel):
    token: str


class SummarizeRequest(BaseModel):
    transcript: str = Field(min_length=1)


class SummarizeResponse(BaseModel):
    summary: str


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/api/login", response_model=LoginResponse)
def login(request: LoginRequest) -> LoginResponse:
    if not AUTH_CODE:
        raise HTTPException(status_code=500, detail="AUTH_CODE is not configured")
    if not hmac.compare_digest(request.username, AUTH_USERNAME):
        raise HTTPException(status_code=401, detail="Invalid login")
    if not hmac.compare_digest(request.access_code, AUTH_CODE):
        raise HTTPException(status_code=401, detail="Invalid login")
    return LoginResponse(token=create_token(request.username))


@app.post("/api/summarize", response_model=SummarizeResponse)
async def summarize(
    request: SummarizeRequest,
    username: str = Depends(require_auth),
) -> SummarizeResponse:
    del username
    return SummarizeResponse(summary=await summarize_with_deepseek(request.transcript))


def signing_secret() -> bytes:
    secret = os.getenv("AUTH_SECRET") or os.getenv("DEEPSEEK_API_KEY") or AUTH_CODE
    if not secret:
        raise HTTPException(status_code=500, detail="AUTH_SECRET is not configured")
    return secret.encode("utf-8")


def create_token(username: str) -> str:
    payload = {"sub": username, "iat": int(time.time())}
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode("utf-8").rstrip("=")
    signature = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{signature}"


def require_auth(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    expected = hmac.new(signing_secret(), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc
    issued_at = int(payload.get("iat", 0))
    if issued_at <= 0 or time.time() - issued_at > TOKEN_TTL_SECONDS:
        raise HTTPException(status_code=401, detail="Token expired")
    username = str(payload.get("sub", ""))
    if username != AUTH_USERNAME:
        raise HTTPException(status_code=401, detail="Invalid token")
    return username


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
