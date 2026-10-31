# Contributing (two-person team, keep it simple)

1. **Work on your own branch.** Never work directly on `main`.
   `git switch -c yourname/what-you-are-doing` (Aluinn starts on `aluinn/start`).
2. **Pull before each session.** Get the latest `main` first:
   `git switch main`, `git pull`, then `git switch your-branch` and `git merge main`.
3. **Small commits, clear messages.** Commit often, e.g. `Add /health route`, not `stuff`.
   `git add <files>` then `git commit -m "message"`.
4. **Push when you finish.** `git push` (the first time: `git push -u origin your-branch`).
5. **Open a pull request into `main`** on GitHub.
6. **The other person glances at it.** A quick look is enough: does it run, any keys or big files by mistake?
7. **`main` must always run.** If it doesn't start, fix it before anything else.

Never commit API keys, `.env`, or large scan files. Log your session in `BUILD_LOG.md`.
Stuck on a merge conflict? Stop and ask the other person; don't guess.
