# Server (FastAPI)

Needs Python 3.11 or newer. Run all commands from inside `server/`.

## First-time setup (virtual environment)

A virtual environment ("venv") is a private box of Python packages for this
project, so it doesn't mess with the rest of your computer.

Mac:

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt

Windows (PowerShell):

    py -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -r requirements.txt

You'll see `(.venv)` at the start of your terminal line when it's active.
Activate it again each time you open a new terminal.

## Run

    uvicorn main:app --reload --port 8000

Then open http://localhost:8000/health. You should see `{"status":"ok"}`.
Auto-generated docs: http://localhost:8000/docs

## Secrets

Never put API keys in code. Copy `../.env.example` to `../.env`, fill in your own
values, and read them with `os.environ`. `.env` is git-ignored.
