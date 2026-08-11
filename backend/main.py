"""
AI Study Assistant - Backend
============================
FastAPI server that powers the AI Study Assistant.
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Callable, Deque, Dict, List, Optional
from contextlib import asynccontextmanager

import fitz  # PyMuPDF
from docx import Document as DocxDocument
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from google.genai.errors import APIError
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("study-assistant")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")

# Security & Quotas
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "12")) # Max requests per IP per minute
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "8")) # File size limit for text extraction

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set.")

client = genai.Client(api_key=GEMINI_API_KEY)

async def cleanup_request_log():
    """Background task to periodically remove expired IPs from the rate limiter."""
    while True:
        await asyncio.sleep(600)  # Sweep every 10 minutes
        now = time.monotonic()
        empty_ips = []
        for ip, window in _request_log.items():
            while window and now - window[0] > 60:
                window.popleft()
            if not window:
                empty_ips.append(ip)
        for ip in empty_ips:
            if ip in _request_log and not _request_log[ip]:
                del _request_log[ip]

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(cleanup_request_log())
    yield
    task.cancel()

app = FastAPI(title="AI Study Assistant", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],  # only methods this API actually uses
    allow_headers=["Content-Type"],
)

TUTOR_SYSTEM_INSTRUCTION = (
    "You are Study Buddy, a patient, encouraging AI study assistant for "
    "students. Explain concepts clearly with simple language and concrete "
    "examples suited to the student's level. Break down complex topics "
    "step by step. Ask short follow-up questions to check understanding "
    "when it helps. Do not simply hand over full homework or exam answers "
    "with no explanation - guide the student's thinking with hints and "
    "reasoning so they actually learn. Keep responses focused and well "
    "organized, using short paragraphs or bullet points where useful. If "
    "the student attaches an image, use it as context for your answer."
)


# --------------------------------------------------------------------------
# Rate limiting (in-memory, per-process sliding window)
# --------------------------------------------------------------------------

_request_log: Dict[str, Deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    """Extracts the real client IP, prioritizing the trusted proxy's X-Forwarded-For entry."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path != "/api/health":
        ip = _client_ip(request)
        now = time.monotonic()
        window = _request_log[ip]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            return JSONResponse(
                status_code=429,
                content={"detail": "Study Buddy is getting a lot of requests right now. Please wait a few seconds and try again."},
                headers={"Retry-After": "15"},
            )
        window.append(now)
    return await call_next(request)


# --------------------------------------------------------------------------
# Request/response models
# --------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str = Field(..., max_length=8000)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    history: List[ChatMessage] = Field(default_factory=list, max_length=40)
    subject: Optional[str] = Field(None, max_length=200)
    image_data: Optional[str] = None        # base64-encoded, no "data:" prefix
    image_mime_type: Optional[str] = None   # e.g. "image/png"


class QuizRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)
    num_questions: int = Field(5, ge=1, le=15)
    difficulty: str = "medium"  # easy | medium | hard
    previous_score_percent: Optional[int] = Field(None, ge=0, le=100)
    auto_difficulty: bool = False


class SummarizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)
    mode: str = "summary"  # "summary" | "flashcards"


# --------------------------------------------------------------------------
# Gemini call helpers: retry-with-backoff wrapper + in-memory result cache
# --------------------------------------------------------------------------

def _is_transient(e: APIError) -> bool:
    if getattr(e, "code", None) in (429, 500, 503):
        return True
    msg = str(e).lower()
    return any(kw in msg for kw in ("rate limit", "resource_exhausted", "unavailable", "try again"))


async def _call_with_retry(coro_fn: Callable, *, retries: int = 2, base_delay: float = 1.0):
    """Wraps Gemini API calls to automatically retry on rate limits or transient server errors."""
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return await coro_fn()
        except APIError as e:
            last_exc = e
            if attempt == retries or not _is_transient(e):
                raise
            delay = base_delay * (2 ** attempt)
            logger.warning("Transient Gemini error (attempt %d/%d): %s - retrying in %.1fs", attempt + 1, retries + 1, e, delay)
            await asyncio.sleep(delay)
    raise last_exc  # pragma: no cover - unreachable, satisfies type checkers


_quiz_cache: Dict[str, tuple] = {}
_CACHE_TTL_SECONDS = 900  # 15 minutes
_CACHE_MAX_ENTRIES = 200


def _cache_get(cache: dict, key: str):
    entry = cache.get(key)
    if not entry:
        return None
    ts, value = entry
    if time.monotonic() - ts > _CACHE_TTL_SECONDS:
        cache.pop(key, None)
        return None
    return value


def _cache_set(cache: dict, key: str, value):
    cache[key] = (time.monotonic(), value)
    if len(cache) > _CACHE_MAX_ENTRIES:
        oldest_key = min(cache, key=lambda k: cache[k][0])
        cache.pop(oldest_key, None)


# --------------------------------------------------------------------------
# Prompt / schema helpers
# --------------------------------------------------------------------------

ALLOWED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}


def build_chat_contents(
    history: List[ChatMessage],
    message: str,
    subject: Optional[str],
    image_data: Optional[str] = None,
    image_mime_type: Optional[str] = None,
):
    contents = []

    if subject:
        contents.append({"role": "user", "parts": [{"text": f"For context, we are focusing on: {subject}"}]})
        contents.append({"role": "model", "parts": [{"text": "Got it, I'll keep that in mind."}]})

    for turn in history:
        role = "user" if turn.role == "user" else "model"
        contents.append({"role": role, "parts": [{"text": turn.content}]})

    parts = [{"text": message}]
    if image_data and image_mime_type:
        if image_mime_type not in ALLOWED_IMAGE_MIME_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported image type '{image_mime_type}'. Allowed: PNG, JPEG, WEBP.",
            )
        try:
            raw = base64.b64decode(image_data, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="That image could not be read. Please try a different file.")
        if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"Image too large (max {MAX_UPLOAD_MB}MB).")
        parts.append({"inline_data": {"mime_type": image_mime_type, "data": image_data}})

    contents.append({"role": "user", "parts": parts})
    return contents


QUIZ_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "questions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "question": {"type": "STRING"},
                    "options": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                    },
                    "correct_index": {
                        "type": "INTEGER",
                        "description": "0-based index into 'options' of the correct answer",
                    },
                    "explanation": {"type": "STRING"},
                },
                "required": ["question", "options", "correct_index", "explanation"],
            },
        }
    },
    "required": ["questions"],
}

FLASHCARD_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "flashcards": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "front": {"type": "STRING"},
                    "back": {"type": "STRING"},
                },
                "required": ["front", "back"],
            },
        }
    },
    "required": ["flashcards"],
}


def _effective_difficulty(req: QuizRequest) -> str:
    if req.auto_difficulty and req.previous_score_percent is not None:
        if req.previous_score_percent < 40:
            return "easy"
        if req.previous_score_percent < 75:
            return "medium"
        return "hard"
    return req.difficulty


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "model": GEMINI_MODEL}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Streams a conversational tutor response back to the client via Server-Sent Events."""
    contents = build_chat_contents(req.history, req.message, req.subject, req.image_data, req.image_mime_type)

    async def event_stream():
        try:
            stream = await _call_with_retry(
                lambda: client.aio.models.generate_content_stream(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=TUTOR_SYSTEM_INSTRUCTION,
                        temperature=0.7,
                    ),
                ),
                retries=1,  # only retry the initial connection, not mid-stream
            )
            async for chunk in stream:
                if chunk.text:
                    yield f"data: {json.dumps({'text': chunk.text})}\n\n"
            yield "data: [DONE]\n\n"
        except APIError:
            logger.exception("Gemini API error during chat stream")
            yield f"data: {json.dumps({'error': 'Study Buddy had trouble responding. Please try again.'})}\n\n"
        except Exception:
            logger.exception("Unexpected error during chat stream")
            yield f"data: {json.dumps({'error': 'Something went wrong. Please try again.'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/quiz")
async def generate_quiz(req: QuizRequest):
    """Generates a structured multiple-choice quiz, optionally adapting difficulty to past scores."""
    difficulty = _effective_difficulty(req)
    cache_key = f"{req.topic.strip().lower()}|{req.num_questions}|{difficulty}"
    cached = _cache_get(_quiz_cache, cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    prompt = (
        f"Create exactly {req.num_questions} multiple-choice quiz questions "
        f"about the topic '{req.topic}', at {difficulty} difficulty for "
        "a student studying this subject. Every question must have exactly "
        "4 answer options, a zero-based correct_index, and a short "
        "explanation of why that answer is correct."
    )
    try:
        response = await _call_with_retry(lambda: client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=QUIZ_SCHEMA,
                temperature=0.6,
            ),
        ))
        data = json.loads(response.text)
        data["difficulty_used"] = difficulty
        _cache_set(_quiz_cache, cache_key, data)
        return data
    except APIError:
        logger.exception("Gemini API error during quiz generation")
        raise HTTPException(status_code=502, detail="Couldn't generate the quiz right now. Please try again shortly.")
    except json.JSONDecodeError:
        logger.exception("Failed to parse quiz JSON from model")
        raise HTTPException(status_code=502, detail="The quiz came back in an unexpected format. Please try again.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected error during quiz generation")
        raise HTTPException(status_code=500, detail="Something went wrong generating the quiz. Please try again.")


@app.post("/api/summarize")
async def summarize(req: SummarizeRequest):
    """Summarizes text notes or extracts them into Q&A flashcards."""
    text_hash = hashlib.sha256(req.text.strip().encode()).hexdigest()[:16]
    cache_key = f"{req.mode}|{text_hash}"
    cached = _cache_get(_quiz_cache, cache_key)
    if cached is not None:
        return {**cached, "cached": True} if isinstance(cached, dict) else cached

    if req.mode == "flashcards":
        prompt = (
            "Read the following study notes and produce 6 to 10 flashcards "
            "covering the key concepts. Each flashcard's 'front' should be a "
            "short question or term, and 'back' should be a concise, "
            f"accurate answer or definition.\n\nNOTES:\n{req.text}"
        )
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_json_schema=FLASHCARD_SCHEMA,
            temperature=0.5,
        )
    else:
        prompt = (
            "Summarize the following study notes into clear, well-organized "
            "bullet points a student can use to quickly review before an "
            f"exam. Highlight key terms and definitions.\n\nNOTES:\n{req.text}"
        )
        config = types.GenerateContentConfig(temperature=0.4)

    try:
        response = await _call_with_retry(lambda: client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=config,
        ))
        result = json.loads(response.text) if req.mode == "flashcards" else {"summary": response.text}
        _cache_set(_quiz_cache, cache_key, result)
        return result
    except APIError:
        logger.exception("Gemini API error during summarize")
        raise HTTPException(status_code=502, detail="Couldn't process those notes right now. Please try again shortly.")
    except json.JSONDecodeError:
        logger.exception("Failed to parse flashcards JSON from model")
        raise HTTPException(status_code=502, detail="The flashcards came back in an unexpected format. Please try again.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected error during summarize")
        raise HTTPException(status_code=500, detail="Something went wrong processing those notes. Please try again.")


ALLOWED_EXTRACT_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "image/png": "image",
    "image/jpeg": "image",
    "image/webp": "image",
}


@app.post("/api/extract")
async def extract_text(file: UploadFile = File(...)):
    """Extracts raw text from uploaded PDFs, DOCX files, or images (via Gemini Vision)."""
    content_type = file.content_type or ""
    kind = ALLOWED_EXTRACT_TYPES.get(content_type)
    if not kind:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file type. Please upload a PDF, DOCX, or image (PNG/JPEG/WEBP).",
        )

    raw = await file.read()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_MB}MB).")

    try:
        if kind == "pdf":
            text = await _extract_pdf_text(raw)
        elif kind == "docx":
            text = _extract_docx_text(raw)
        else:
            text = await _extract_image_text(raw, content_type)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to extract text from uploaded file")
        raise HTTPException(status_code=500, detail="Couldn't read that file. Please try a different one.")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="No readable text was found in that file.")
    return {"text": text[:20000]}  # match the notes size limit used elsewhere


def _sync_pdf_to_parts(raw: bytes):
    with fitz.open(stream=raw, filetype="pdf") as doc:
        text = "\n".join(page.get_text() for page in doc)
        if text.strip():
            return text, None

        page_images = []
        for i in range(min(len(doc), 10)):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
            page_images.append(pix.tobytes("png"))
        return None, page_images


async def _extract_pdf_text(raw: bytes) -> str:
    text, page_images = await asyncio.to_thread(_sync_pdf_to_parts, raw)
    if text:
        return text

    parts = [{
        "text": (
            "Transcribe all readable text from these scanned pages as plain text. "
            "Preserve headings and structure where clear. Do not add commentary."
        )
    }]
    for png_bytes in (page_images or []):
        parts.append({
            "inline_data": {
                "mime_type": "image/png",
                "data": base64.b64encode(png_bytes).decode("ascii"),
            }
        })

    response = await _call_with_retry(lambda: client.aio.models.generate_content(
        model=GEMINI_MODEL,
        contents=[{"role": "user", "parts": parts}],
        config=types.GenerateContentConfig(temperature=0.1),
    ))
    return response.text or ""


def _extract_docx_text(raw: bytes) -> str:
    doc = DocxDocument(io.BytesIO(raw))
    return "\n".join(p.text for p in doc.paragraphs)


async def _extract_image_text(raw: bytes, mime_type: str) -> str:
    prompt = (
        "Transcribe all readable text from this image of study notes as "
        "plain text. Preserve headings and structure where clear. Do not "
        "add commentary or explanation, only return the transcribed text."
    )
    response = await _call_with_retry(lambda: client.aio.models.generate_content(
        model=GEMINI_MODEL,
        contents=[{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(raw).decode("ascii")}},
            ],
        }],
        config=types.GenerateContentConfig(temperature=0.1),
    ))
    return response.text or ""


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logger.warning("Frontend directory not found at %s - static files will not be served.", FRONTEND_DIR)
