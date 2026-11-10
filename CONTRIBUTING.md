# Contributing

Thanks for wanting to help. Room world started as a two-person hackathon project, so the process is small and friendly. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Set up

Full instructions are in the [README quick start](README.md#quick-start). In short:

```bash
git clone https://github.com/aluinn/meta-developer-hackathon.git
cd meta-developer-hackathon
cd web && npm install                      # web app
cd ../server && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

You do not need an API key to work on the web app, the tests or the ready-made rooms. Only features that call Meta's models (scanning, voice, layout agent, character maker) need a `MODEL_API_KEY` in `server/.env`. Never commit `.env`, API keys or scan files.

## Commands

| Where | Command | What it does |
|---|---|---|
| `web/` | `npm run dev` | Dev server (http://localhost:5173) |
| `web/` | `npx tsc --noEmit` | Type-check. Run before every commit. |
| `web/` | `for f in scripts/test-*.ts; do node $f; done` | Web tests (plain Node) |
| `server/` | `uvicorn main:app --reload --port 8000` | API server |
| `server/` | `for f in scripts/test_*.py; do python $f; done` | Server tests (fake AI answers, free, no key) |

## Who works where

The code is split so two people can work without colliding: `/server` (Python, the AI pipeline) and `/web` (TypeScript, the app and simulation). **`/shared` is the contract between them** (`world.schema.json` and the example worlds). A change there needs the maintainers' agreement; if you change the schema, update `shared/example_world.json` (it must always validate) and both sides.

## Branches

Work on a branch, never directly on `main`. Name it `type/short-description`, for example `feature/wheelchair-preset`, `fix/zac-room-gates`, `docs/faq`. Start from the latest `main`. `main` must always run.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, in the present tense and under about 72 characters.

| Type | Use for |
|---|---|
| `feat` | a new capability |
| `fix` | a bug fix |
| `docs` | documentation only |
| `test` | tests only |
| `refactor` | no behaviour change |
| `ci` / `chore` | workflows, tooling, housekeeping |

Examples: `feat(web): add a 0.6 m person preset`, `fix(server): reject empty uploads`. Keep commits small and focused.

## Pull requests

1. Open a PR into `main` using the template.
2. Say what changed and why, and how you checked it. Include a screenshot for visible changes.
3. Make sure the type-check and both test suites pass.
4. One reviewer glances at it: does it run, and are there keys or big files by mistake?
5. Add a short entry to [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for anything a user would notice.

## Rules from the hackathon that still apply

- **Original assets only.** Check the licence of any library or asset **before** adding it, and list it in [THIRD_PARTY.md](THIRD_PARTY.md). Please open an issue before adding a new dependency.
- Plain English in comments and docs. Prefer simple over clever. TypeScript is strict with no `any`; Python has type hints.
- Log notable working sessions in [BUILD_LOG.md](BUILD_LOG.md) (newest first).

Stuck on a merge conflict, or not sure whether something fits? Open an issue or ask in the PR. Do not guess.
