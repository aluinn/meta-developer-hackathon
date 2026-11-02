# Room world

Hackathon project by Aluinn and Zac: turn a scan of a real room into a playable 3D world.
Pipeline: scan -> server (AI) -> `world.json` -> web app (three.js + Rapier physics).

## Folders
- `web/` - Vite + TypeScript app (three.js, Rapier)
- `server/` - Python FastAPI server
- `shared/` - `world.schema.json` + `example_world.json` (the contract between the two)
- `docs/` - demo script and architecture notes

## Setup (once)

Install these, then close and reopen your terminal:

| Tool | Mac | Windows |
|---|---|---|
| Git | `xcode-select --install` or https://git-scm.com | https://git-scm.com/download/win |
| Node.js LTS | https://nodejs.org | https://nodejs.org |
| Python 3.11+ | https://python.org/downloads | https://python.org/downloads (tick "Add to PATH") |

Check: `git --version`, `node --version`, `python3 --version` (Windows: `py --version`).

Clone and install:

    git clone https://github.com/aluinn/meta-developer-hackathon.git
    cd meta-developer-hackathon
    cd web && npm install && cd ..

Server (Mac):

    cd server
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt

Server (Windows PowerShell):

    cd server
    py -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -r requirements.txt

If PowerShell blocks activation, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

API key: copy `.env.example` to `.env` and put in your own key. Never commit `.env`.

## Run the web app

    cd web
    npm run dev

Open http://localhost:5173 - you should see "Room world".
To try on your phone (same Wi-Fi): `npm run dev -- --host`, then open the "Network" URL shown.

## Run the server

    cd server
    source .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
    uvicorn main:app --reload --port 8000

Open http://localhost:8000/health - you should see `{"status":"ok"}`.

## Run everything as one server (like the deployed site)

    cd web && npm run build
    cd ../server && source .venv/bin/activate && uvicorn main:app --port 8000

Open http://localhost:8000: the website, with the API at the same address (`/docs` for the API test page).

## Working together
Read [CONTRIBUTING.md](CONTRIBUTING.md). Log sessions in [BUILD_LOG.md](BUILD_LOG.md).
Third-party licences: [THIRD_PARTY.md](THIRD_PARTY.md).
