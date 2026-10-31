# Room world: team brief (working title)

Team: Aluinn McDonald and Zac. Meta Global AI Developer Hackathon, Indie Developer track.

## Check these first
- **Zac's place.** Confirm Zac was accepted into the hackathon (applications closed Oct 25). If not, ask in the Discord #questions channel whether he can still join the team. Don't assume.
- **Credits.** Each person claims their own $150 of Meta API credits through the form in the participant guide, by 9pm ET on Nov 4. Credits can't be claimed for someone else, and a card is needed on the account. Aluinn has his. Zac needs to claim his.
- **Claude Code.** Ask in #questions whether third-party coding tools like Claude Code are allowed, as long as the project runs on Meta's models.
- **Keys.** Never paste API keys into chat, docs or GitHub. They live in a .env file that git ignores.

## The idea
Scan a room with an iPhone (LiDAR), and it becomes a labelled, physics-ready 3D world you can use two ways: an AI layout agent that rearranges the room and checks a person can still walk through it, and a play mode where a character jumps across your real furniture.

**Who it's for:** anyone rearranging a home, people who need wider clearances (walker or wheelchair), game developers who want levels from real spaces, and AI researchers who need test environments.

**Honest limits (say these in the video):** phone LiDAR gives approximate sizes, so all measurements are estimates. It's a planning aid, not a safety assessment, and it doesn't replace a cane or guide dog.

## How it works
It's a web app that runs on phone and laptop. The scan comes from an external scanning app, and everything after the scan is ours. The Meta model calls happen on a server, not in the browser.

1. iPhone LiDAR scan, exported as a file (input, external app)
2. Upload and simplify the mesh (Aluinn, A1)
3. SAM 3.1 labels the furniture, mapped onto the 3D scan (Aluinn, A2)
4. Muse Spark decides each object's role and writes world.json (Aluinn, A3)
5. world.json is the handover between us. Zac's side loads it into the browser 3D world (Zac, Z2)
6. Two branches from the world:
   - Layout agent: Voice input (Zac, Z5, using Muse Voice Transcribe), then Layout agent (Aluinn, A4, Muse Spark), then Clearance check with a simulated person (Zac, Z4), then Before and after (Aluinn, A5, Muse Image render; Zac, Z6, the view)
   - Play mode: character jumps across the real furniture (Zac, Z3)
7. Verification scores on screen: scan-versus-simulation match (Aluinn, A6) and walkability (Zac, Z4)

## Work split
Both halves can be built at the same time because of one shared file. world.json lists every object in the room: its id, label, role (fixed, movable, climbable, passable), position, size in metres, and the floor, bounds, spawn and goal points. Zac builds against shared/example_world.json until Aluinn's pipeline produces real ones.

**Aluinn: the AI pipeline (server)**
- A1: upload a scan and simplify the mesh
- A2: SAM 3.1 labelling mapped onto the 3D scan. Fallback: Spark labels images rendered from the scan
- A3: Muse Spark object roles, output world.json
- A4: layout agent that proposes new positions for movable objects from a spoken or typed goal
- A5: Muse Image: before and after render, plus an original character image for Zac
- A6: scan-versus-simulation score, and deploying the server

**Zac: the web app and simulation (browser)**
- Z1: phone-first app shell: upload, loading and results screens, also works on laptop
- Z2: 3D viewer that loads world.json and the scan
- Z3: play mode: character, physics (Rapier), touch thumbstick and jump button, keyboard controls
- Z4: clearance check: a simulated person (adjustable width, walker or wheelchair option) walks the layout, shown green or red, plus the walkability score
- Z5: voice input: record in the browser, send to the server, show the transcript
- Z6: before and after view and demo polish

**Shared:** test on 10 rooms (5 each), write the demo script, record the video, README, submission. If one side is overloaded, swap tasks. The hardest pieces are A2, Z3 and Z4.

## Suggested tech (Claude Code can adjust)
- Web app: Vite, TypeScript, three.js, Rapier
- Server: Python (FastAPI). Meta's API works with OpenAI-style clients, per their quickstart. Check dev.meta.ai/docs and the cookbook for exact model names and calls.
- Hosting: Vercel for the web app, and a simple host for the server

## Timeline (deadline is 9pm ET Wed Nov 4, which is 2am Thu Nov 5 UK. Aim to submit Wednesday evening.)
- Sat Oct 31: Zac confirms his place and claims credits. Repo scaffold done. Agree world.json. Export 2 to 3 room scans.
- Sun Nov 1: Aluinn: A1 to A3 on one scan. Zac: Z1 to Z3 with the fake room. Gate at end of day: real labels working and a character moving on the room. If the SAM-to-3D mapping isn't working, switch to the fallback.
- Mon Nov 2: Aluinn: A4, A5. Zac: Z4, Z5.
- Tue Nov 3: integrate everything, verification scores, test 10 rooms, record clips. This is the last full day for submission questions.
- Wed Nov 4: 3-minute video, README, submit with buffer.

Cut first if short on time: room variants, game-engine export, voice editing, play-mode polish. Never cut the layout agent, the verification scores or a clean demo.

## Demo plan (3 minutes)
1. Scan a room on camera (20s)
2. Play it on the phone, jumping across the real sofa (30s)
3. Ask for a new layout by voice, then show the clearance check (60s)
4. Before and after render with the verification scores on screen (30s)
5. Who it helps and the limits (20s)

## Rules to remember
- The repo must be public, and everyone who worked on it must be listed on the submission. Suggest Aluinn as the team Representative.
- The demo must show only what we built during the hackathon, so keep commits small and keep BUILD_LOG.md updated.
- Use only original characters and assets, and check licences on every library.
- Judging: Impact 30%, Meta tooling 25%, Demo 25%, Technical depth 20%.
- Avoid anti-projects such as sports coaches, basic image analyzers and medical advice.

## Git habits for both of you
- main should always work. Each of you works on your own branch (aluinn/..., zac/...).
- Run git pull before you start each session, and push when you finish.
- Make small commits. Merge to main through a pull request, and the other person glances at it first.
- Add a line to BUILD_LOG.md after each session. Claude Code can do this for you.
