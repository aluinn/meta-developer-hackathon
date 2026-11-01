# Server image (build context = repo root, so shared/world.schema.json is included).
FROM python:3.12-slim

# ffmpeg lets POST /transcribe convert browser audio (WebM/Ogg/MP4) to WAV.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY shared/ shared/

RUN useradd --create-home app && chown -R app /app
USER app
WORKDIR /app/server
ENV PYTHONUNBUFFERED=1

# Secrets (MODEL_API_KEY) and ALLOWED_ORIGINS are set in the host's settings, never baked into the image.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
