# One image that serves the API and the website (build context = repo root).

# --- stage 1: build the web app (Vite). It imports ../../shared/*.json, so shared/ sits next to web/.
FROM node:26-slim AS webbuild
WORKDIR /build
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web/ web/
COPY shared/ shared/
RUN cd web && npm run build

# --- stage 2: the Python server, plus the built site
FROM python:3.12-slim

# ffmpeg lets POST /transcribe convert browser audio (WebM/Ogg/MP4) to WAV.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY shared/ shared/
COPY --from=webbuild /build/web/dist web/dist

RUN useradd --create-home app && chown -R app /app
USER app
WORKDIR /app/server
ENV PYTHONUNBUFFERED=1
# glibc keeps a separate memory pool per thread by default, which wastes memory on a 512 MB host; 2 is enough.
ENV MALLOC_ARENA_MAX=2

# Secrets (MODEL_API_KEY) are set in the host's settings, never baked into the image.
# ALLOWED_ORIGINS is only needed if the web app is hosted somewhere else (not in this all-in-one setup).
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
