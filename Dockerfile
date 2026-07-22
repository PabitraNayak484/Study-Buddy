# ---- AI Study Assistant: single-container image (FastAPI + static frontend) ----
FROM python:3.12-slim

WORKDIR /app

# Install backend dependencies first so Docker can cache this layer
# whenever only application code (not dependencies) changes.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy the backend and the static frontend it serves.
COPY backend ./backend
COPY frontend ./frontend

# A non-root user is a cheap, meaningful security improvement for anything
# that will be reachable on the public internet.
RUN useradd --create-home appuser
USER appuser

ENV PORT=8000
EXPOSE 8000

# --app-dir lets us keep the "backend/" folder structure on disk while
# importing main:app directly, without needing an __init__.py package file.
CMD ["sh", "-c", "uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT}"]
