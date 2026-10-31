from fastapi import FastAPI

app = FastAPI(title="Room world server")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
