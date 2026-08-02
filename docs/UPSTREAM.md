# Syncing OpenChamber upstream into Hao Work

Hao Work is the primary product and a GitHub fork of `openchamber/openchamber`.
Keep `origin` for Hao Work and use `upstream` only as a read-only source of
selected implementation changes.

```bash
git fetch upstream
git switch main
git merge --no-ff upstream/main
bun install --frozen-lockfile
bun run type-check
bun run lint
```

Before merging, inspect `origin/main..upstream/main` and select only useful
features, bug fixes, security fixes, performance fixes, and tests. Resolve
conflicts with the current Hao Work project as the default: preserve Hao Work
branding, product-visible names, package metadata, release configuration, and
the HaoCode integration boundary, then reapply the selected upstream behavior.
Hao Work-owned code should stay concentrated in `packages/haocode-bridge`,
`packages/web/server/lib/haocode`, and the Electron HaoCode runtime boundary.
Never copy or replace the full OpenChamber tree, and do not accept upstream
branding or user-facing labels without an explicit product decision.

After the merge, review changed occurrences of `OpenChamber`/`OpenCode` and
confirm that they are compatibility identifiers or technical references rather
than accidental Hao Work UI or release names. Run the affected package checks
before pushing to `origin`.

After validation, push only to the fork:

```bash
git push origin main
```
