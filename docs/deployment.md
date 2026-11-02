# Deploying the server

Goal: one public address that serves **both** the website (Zac's web app) and the API, so the judges open one link. The Meta API key lives
only in the host's secret settings, never in this repo.

## One server for everything (how it works)
The `Dockerfile` builds the web app (`npm run build`) and copies the result next to the Python server. FastAPI serves the website at `/`
and the API at its own paths (`/health`, `/scan`, `/world/...`, `/docs` ...). The API routes are registered first, so they always win; the
website only answers paths the API doesn't. Locally you can try the same thing without Docker:
```
cd web && npm run build
cd ../server && uvicorn main:app --port 8000     # then open http://localhost:8000
```
(If `web/dist` doesn't exist the server just runs the API alone.) Because the page and the API come from the same address:
- **No CORS needed** in production. `ALLOWED_ORIGINS` only matters while developing with `npm run dev` (page on :5173, API on :8000).
- **The web app calls the API with relative paths**, e.g. `fetch('/layout', ...)`, never `http://localhost:8000/layout`. The proxy in `web/vite.config.ts` already forwards
  `/scan`, `/world`, `/layout`, `/render`, `/transcribe`, `/score` and `/health` to port 8000 under `npm run dev`, so the same relative paths work on :5173. New code (`/layout`, voice, render) should use the same pattern as `web/src/api.ts`.
- **No separate Vercel deploy is needed.** Render serves the site too.

## Options

| Host | Effort | Notes |
|---|---|---|
| **Render** (recommended) | Easiest: connect GitHub, click, paste the key | Runs our `Dockerfile`; secrets in the dashboard; free plan needs no card. **Free plan sleeps after 15 min idle, takes about a minute to wake, and its disk is wiped on every restart/sleep/redeploy.** |
| Railway | Easy | Also connects to GitHub; usage-based billing. Sources disagree on its free credit and card requirement, so check its pricing page. |
| Fly.io | More setup | Needs the `flyctl` command line and a `fly.toml`; good Docker control and volumes. Billing has been described as harder to predict. |
| Google Cloud Run | Heavier | Scales to zero, but needs a Google Cloud project and billing set up. |
| Vercel | Not a good fit for the server | Serverless: no ffmpeg, short time limits and no persistent files, but our scan pipeline needs all three. (Not needed for the website either, since Render serves it.) |

(Render's free-plan facts are from render.com/docs/free. The other hosts' details come from third-party comparisons dated 2026
that disagree with each other. Check each pricing page before relying on them.)

**Recommendation: Render.** It is the shortest path from "code on GitHub" to a URL, and `render.yaml` in this repo does the setup.

## The one thing to plan around: files are temporary
Everything in `scans/` (uploads, labels, `world.json`, renders) lives on the server's disk. On Render's free plan that disk is erased
when the service restarts, redeploys, or spins down after 15 idle minutes. So:
- Run the whole chain (upload, label, world, layout, render) in one sitting, shortly before you need it.
- Before a demo, load the page once to wake the server (about a minute), and don't let it sit idle.
- For a reliable demo, use a paid Render plan so it never sleeps. A paid plan can also mount a persistent disk
  (set `SCANS_DIR` to the mount path, e.g. `/var/data/scans`); Render says disks are not available on the free plan.
- Always keep a copy of your best `world.json` in `shared/` so the web app can fall back to it.

## Steps (Render)
1. **Push your branch** to GitHub (`git push`). Render deploys a branch you choose: use `aluinn/start` while testing, then `main` once the pull request is merged.
2. In the Render dashboard: **New +, Blueprint**, connect GitHub, pick `meta-developer-hackathon` and the branch. Render reads `render.yaml`.
3. Render asks for two values (this is what `sync: false` means; it never stores them in the repo):
   - `MODEL_API_KEY`: paste your own Meta key here. Nowhere else.
   - `ALLOWED_ORIGINS`: only needed if the website is hosted somewhere else. With the all-in-one setup, enter `http://localhost:5173` (it just can't be left empty).
     Several are allowed, comma-separated, with no trailing slash or spaces.
4. Click **Apply**. The first build takes a few minutes. Render shows the URL, like `https://your-service-name.onrender.com`.
5. Check it: open `https://<your-url>/health`. You should see `{"status":"ok"}`. (First request after sleeping takes about a minute.)
   Then open `https://<your-url>/` for the website, and `https://<your-url>/docs` for the API test page.
6. Every push to the branch Render watches rebuilds both the site and the server. (The build is longer now: it installs and builds the web app first.)

## Changing the key or origins later
Render dashboard, your service, **Environment**: edit and save. Never commit a `.env` file. If a key is ever pasted into a chat,
a commit or a screenshot, revoke it in Meta's developer portal and make a new one.

## Run the same container locally (optional, needs Docker)
```
docker build -t room-world-server .
docker run --rm -p 8000:8000 -e MODEL_API_KEY=your-key -e ALLOWED_ORIGINS=http://localhost:5173 room-world-server
```

## Risks to know about
- **The endpoints are public and cost money.** Anyone with the URL could call `/scan/{id}/label`, `/render` and so on, which spend your Meta credits ($150 each).
  Keep the URL out of the public README, deploy close to demo time, and watch your credit balance. If that worries you, ask for a simple access token to be added.
- **The free plan has 512MB of memory (check the dashboard).** Very large scans could run out; A1 already caps uploads at 100MB.
