## What and why

<!-- What does this change, and why? Link the issue (Closes #123). -->

## How I checked it

- [ ] `cd web && npx tsc --noEmit`
- [ ] Web tests (`for f in scripts/test-*.ts; do node $f; done`)
- [ ] Server tests (`for f in scripts/test_*.py; do python $f; done`)
- [ ] Tried it in the browser (screenshot below if the change is visible)

## Checklist

- [ ] Commit messages follow Conventional Commits
- [ ] No keys, `.env` or scan files committed
- [ ] New library or asset? Licence checked and added to `THIRD_PARTY.md`
- [ ] Changed `shared/world.schema.json`? `shared/example_world.json` still validates and both sides are updated
- [ ] Added a line to `CHANGELOG.md` if users will notice
