from fastapi import FastAPI

from scans import router as scans_router

app = FastAPI(title="Room world server")
app.include_router(scans_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
