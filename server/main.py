import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from characters import router as characters_router
from jobs import router as jobs_router
from labels import router as labels_router
from layout import router as layout_router
from photo_render import router as render_router
from scans import router as scans_router
from score import router as score_router
from transcribe import router as transcribe_router

load_dotenv()

# Browser origins allowed to call this server (the web app). Comma-separated; set ALLOWED_ORIGINS on the host,
# e.g. ALLOWED_ORIGINS=https://room-world.vercel.app. The default is local development only.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]

app = FastAPI(title="Room world server")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])
app.include_router(scans_router)
app.include_router(labels_router)
app.include_router(jobs_router)
app.include_router(characters_router)
app.include_router(layout_router)
app.include_router(render_router)
app.include_router(score_router)
app.include_router(transcribe_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# One server for everything: if the web app has been built (cd web && npm run build), serve it at "/".
# This is mounted last, so every API route above wins; the site only answers paths the API does not.
WEB_DIST = Path(os.environ.get("WEB_DIST") or Path(__file__).resolve().parent.parent / "web" / "dist")
if (WEB_DIST / "index.html").exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
