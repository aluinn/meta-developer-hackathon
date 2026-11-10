# Security Policy

## Reporting a vulnerability

Please report security problems **privately** using GitHub's private vulnerability reporting: open the repository's **Security** tab, then **Report a vulnerability**. Please do not open a public issue for a security problem. We will acknowledge a report as soon as we can and keep you updated. This is a small volunteer project, so we cannot promise a fixed response time.

## Supported versions

Only the latest commit on `main` is supported. There are no versioned releases yet.

## Scope and design notes

Things worth knowing when you look for problems (all checked in the code):

- **API key.** `MODEL_API_KEY` lives only in the server's environment (`.env`, or the host's secrets). The browser never sees it. `.env` is git-ignored; only `.env.example` with a placeholder is committed.
- **Uploads.** `POST /scan` accepts only `.glb` and `.obj` and enforces a 100 MB limit while streaming (`server/scans.py`). Scans are stored under `SCANS_DIR` and are not committed.
- **Spending limits.** The character maker is rate limited per visitor and globally (`CHARACTER_*` settings in `.env.example`), because each drawing costs real money.
- **No accounts, no database.** There is no sign-in. Scan jobs are held in memory, and scan files are on disk on the server.
- **CORS.** Allowed browser origins come from `ALLOWED_ORIGINS`; the default is local development only.
- **Scan data is private to whoever has its id.** A scan is addressed by a random 32-character id; there are no other access controls. Do not upload scans of places you would not want shared.

In scope: the server in `/server`, the web app in `/web`, and the Docker and Render setup. Out of scope: the Meta API itself, the Render platform, and the accuracy of scan measurements (these are estimates and documented as a planning aid, not a safety assessment).
