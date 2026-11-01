from fastapi import FastAPI

from labels import router as labels_router
from layout import router as layout_router
from scans import router as scans_router
from transcribe import router as transcribe_router

app = FastAPI(title="Room world server")
app.include_router(scans_router)
app.include_router(labels_router)
app.include_router(layout_router)
app.include_router(transcribe_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
