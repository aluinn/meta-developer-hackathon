from fastapi import FastAPI

from labels import router as labels_router
from scans import router as scans_router

app = FastAPI(title="Room world server")
app.include_router(scans_router)
app.include_router(labels_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
