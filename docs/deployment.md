# Deploying the server

Goal: the FastAPI server runs somewhere public so Zac's web app (and the judges) can reach it. The Meta API key lives
only in the host's secret settings, never in this repo.

## Options

| Host | Effort | Notes |
|---|---|---|
| **Render** (recommended) | Easiest: connect GitHub, click, paste the key | Runs our `Dockerfile`; secrets in the dashboard; free plan needs no card. **Free plan sleeps after 15 min idle, takes about a minute to wake, and its disk is wiped on every restart/sleep/redeploy.** |
| Railway | Easy | Also connects to GitHub; usage-based billing. Sources disagree on its free credit and card requirement, so check its pricing page. |
| Fly.io | More setup | Needs the `flyctl` command line and a `fly.toml`; good Docker control and volumes. Billing has been described as harder to predict. |
| Google Cloud Run | Heavier | Scales to zero, but needs a Google Cloud project and billing set up. |
| Vercel | Not a good fit | Serverless: no ffmpeg, short time limits and no persistent files, but our scan pipeline needs all three. Use Vercel for Zac's web app instead. |

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
   - `ALLOWED_ORIGINS`: the web app's address, e.g. `https://room-world.vercel.app`. Until Zac has one, use `http://localhost:5173`.
     Several are allowed, comma-separated, with no trailing slash or spaces.
4. Click **Apply**. The first build takes a few minutes. Render shows the URL, like `https://room-world-server.onrender.com`.
5. Check it: open `https://<your-url>/health`. You should see `{"status":"ok"}`. (First request after sleeping takes about a minute.)
   Also try `https://<your-url>/docs`.
6. When Zac has deployed the web app, change `ALLOWED_ORIGINS` in Render (Environment tab) and save. Render restarts the server.

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
