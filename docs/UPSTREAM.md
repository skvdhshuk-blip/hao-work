# Syncing OpenChamber upstream

Hao Work is a GitHub fork of `openchamber/openchamber`. Keep `origin` for
Hao Work and use `upstream` as a read-only source of OpenChamber changes.

```bash
git fetch upstream
git switch main
git merge --no-ff upstream/main
bun install --frozen-lockfile
bun run type-check
bun run lint
```

Resolve conflicts by preserving new upstream UI behavior first, then reapplying
the smallest Hao Work integration needed. Hao Work-owned code should stay
concentrated in `packages/haocode-bridge`,
`packages/web/server/lib/haocode`, and the Electron HaoCode runtime boundary.
Avoid copying or replacing the full OpenChamber tree.

After validation, push only to the fork:

```bash
git push origin main
```
