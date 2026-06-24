---
name: publish-qalatra
description: Cut a full Qalatra release end-to-end — commit code with good notes, bump version, tag, publish a GitHub release, and sync the changelog + docs in ../qalatra.com. Use whenever Justin says "publish", "release", "deploy", "cut a release", or /publish-qalatra.
---

# Publish Qalatra

Run the complete release process. Justin does **not** do any of these steps manually — you own all of them, on whatever box you're running on. Do the work, then report what shipped. Don't explain the process back to Justin first — just run it.

This skill is path-portable: it uses **relative paths only**. The qalatra repo and the website repo are always siblings, so the website is always at `../qalatra.com` regardless of the absolute checkout location (Mac, Linux, etc.).

## Preconditions

- Run from the repo root (the directory containing `package.json` and `electron-builder.yml`).
- Confirm the website sibling exists before relying on it: `ls ../qalatra.com >/dev/null` — if it's missing, do the qalatra release steps, then tell Justin the website couldn't be synced and stop short of step 6–7.
- Both repos are on the `develop` branch.

## Steps

### 1. Review what's changed since the last release
- `git -C . log "$(git describe --tags --abbrev=0)"..HEAD --oneline` to see commits since the last tag.
- `git status` and `git diff` to see uncommitted work.
- Synthesize this into a human-readable summary of everything since the last tag — this feeds the commit message, the GitHub release notes, and the changelog entry.

### 2. Decide the new version
- Read current version: `node -p "require('./package.json').version"`.
- Pick the next version (patch unless the changes are clearly feature/breaking). When in doubt, bump patch.

### 3. Commit all code changes
- `git add -A`
- Commit with a descriptive message covering everything since the last tag.
- End the commit message with the required co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

### 4. Bump version + commit the bump (MUST come before the tag)
- Edit `package.json` `version` to the new version.
- `git add package.json && git commit -m "Bump version to X.Y.Z"`
- **Verify before tagging:** `git show HEAD:package.json | grep '"version"'` must match the tag you're about to create.
  - Why this ordering matters: electron-builder reads `package.json` for the release name. If the tag points at a commit with the *old* version, CI publishes a release with the wrong number and the workflow's `gh release edit <tag>` fails with "release not found". This is what broke the 1.3.1 publish.

### 5. Tag and push (this triggers the CI release build)
```
git push origin develop
git tag vX.Y.Z
git push origin vX.Y.Z
```
- The tag must equal the `package.json` version (with a `v` prefix).
- Tagging triggers `.github/workflows/release.yml`: builds the macOS DMG + ZIP (arm64 + x64), code-signs, notarizes, and publishes to GitHub Releases. The in-app auto-updater picks it up from there.

### 6. Write GitHub release notes
- The CI workflow creates the release. Once it exists, set good notes:
  `gh release edit vX.Y.Z --notes "<summary from step 1>"`
- If the release doesn't exist yet (CI still building), either wait and retry, or create notes now with `gh release create` only if CI hasn't — prefer letting CI create it and editing the notes after.

### 7. Sync the website (../qalatra.com, also on develop)
The website is a pnpm + Nx monorepo. Update these, then commit + push to `origin/develop` (no separate version/tag needed for the website):
- **Changelog** — `../qalatra.com/apps/web/app/routes/_marketing/changelog.tsx`: add a new entry at the top of the `RELEASES` array, move `current: true` to the new version (remove it from the previous entry), and include all changes since the previous release.
- **Docs** — check `../qalatra.com/apps/web/app/routes/_marketing/docs/` for anything that new features in this release make stale, especially:
  - `docs/mcp.tsx`
  - `docs/remote-instances.tsx`
- Commit and push:
  ```
  git -C ../qalatra.com add -A
  git -C ../qalatra.com commit -m "Changelog + docs for Qalatra vX.Y.Z"
  git -C ../qalatra.com push origin develop
  ```

### 8. Report
Tell Justin: the version shipped, the tag, the GitHub release URL, and which website pages were updated.

## Gotchas
- **Commit signing is per-box, not part of this skill** — each box configures its own git identity + signing:
  - **Interactive Mac (Justin's laptop):** signs via 1Password (`gpg.ssh.program = op-ssh-sign`). If a commit fails because the 1Password / GPG / SSH signer can't sign (e.g. the desktop prompt didn't appear), STOP immediately and ask Justin to signal when ready. Do **not** retry in a loop or disable signing as a workaround.
  - **Headless box (agent account):** signs non-interactively with an on-disk SSH key under its own git identity (e.g. `shi@pirateandfox.com`); there is no prompt, so signing should just succeed. If `git commit` fails with a signing error here, report the exact error and stop — it means the box's git signing config is broken; do not silently fall back to unsigned commits.
- Verify `package.json` version == tag before pushing the tag (step 4).
- Never publish the website without the changelog entry — the changelog page is the public record of the release.
