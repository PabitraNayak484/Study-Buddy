# Study Buddy — AI Study Assistant

A full-stack AI web app that helps students study through a conversational tutor, an on-demand quiz generator, and a notes-to-flashcards tool. Features include file upload, voice input/output, dark mode, and a Pomodoro timer. Built with a Python FastAPI backend, a vanilla HTML/CSS/JS frontend, and Google's Gemini API.

## Features

- **Chat Tutor** — Ask questions and get step-by-step explanations that stream progressively. Supports subject focus, photo attachments (e.g., diagrams), and voice input. Bot replies can be read aloud.
- **Quiz Me** — Generates a structured multiple-choice quiz on any topic with instant feedback. Optional auto-difficulty adjusts based on your last score. Missed questions can be added to your flashcard deck.
- **Notes & Flashcards** — Paste notes or upload a PDF, DOCX, or photo to generate a bullet-point summary or tap-to-flip flashcards. Export your deck to a plain-text Anki-importable file or save as a PDF.
- **Study Timer** — A Pomodoro-style focus timer with presets.
- **Dark Mode & Mobile Responsive** — The interface adapts to narrow screens and includes a theme toggle.

## Tech stack

| Layer      | Choice                                   |
|------------|-------------------------------------------|
| Frontend   | HTML / CSS / JavaScript |
| Backend    | Python, FastAPI, Uvicorn |
| LLM        | Google Gemini API (`google-genai` SDK)    |
| File parsing | PyMuPDF (PDF), python-docx (DOCX), Gemini vision (photos and OCR fallback for scanned PDFs) |
| Container  | Docker (single image serves both layers)  |
| Deployment | Render (Free Tier) or AWS Elastic Beanstalk |

## Project structure

```
study-assistant/
├── backend/
│   ├── main.py           # FastAPI app: /api/chat, /api/quiz, /api/summarize, /api/extract
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── Dockerfile
├── render.yaml           # blueprint for 1-click Render deployment
├── .dockerignore
├── .env.example
├── RENDER_DEPLOYMENT.md  # step-by-step Render free hosting guide
└── DEPLOYMENT.md         # step-by-step AWS deployment guide
```

## Running locally

**1. Get a Gemini API key**
Create one at https://aistudio.google.com/apikey (free tier is sufficient).

**2. Configure environment variables**
```bash
cp .env.example .env
# then edit .env and paste in your key
```

**3a. Run with Python directly**
```bash
cd backend
python3 -m venv venv && source venv/bin/activate    # optional but recommended
pip install -r requirements.txt
export $(cat ../.env | xargs)   # loads env vars into the shell (macOS/Linux)
uvicorn main:app --reload --app-dir . --port 8000
```
Visit http://localhost:8000

**3b. Run with Docker**
```bash
docker build -t study-buddy .
docker run --rm -p 8000:8000 --env-file .env study-buddy
```
Visit http://localhost:8000

## Configuration reference

All of these are optional except `GEMINI_API_KEY` — see `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(required)* | Your Gemini API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Which Gemini model to call |
| `ALLOWED_ORIGINS` | *(empty)* | Extra origins allowed to call this API cross-site. Leave blank unless you specifically need another site to embed calls to your API. |
| `RATE_LIMIT_PER_MINUTE` | `12` | Requests allowed per visitor per rolling 60s window, across all `/api/*` routes |
| `MAX_UPLOAD_MB` | `8` | Max file size accepted by `/api/extract` and image chat attachments |

## Security & reliability notes

- The Gemini API key is stored server-side and never exposed to the frontend.
- Rate limiting protects the API quota from exhaustion.
- CORS is closed by default.
- Input size limits are enforced on all text fields.
- Full exception details are logged server-side and never sent to the client.
- Automatic retry with backoff is implemented for transient API errors.

## Deployment

This app is fully containerized and can be deployed anywhere that supports Docker. We provide two step-by-step guides depending on your needs:
