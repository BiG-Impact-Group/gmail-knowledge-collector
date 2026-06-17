---
name: feature-commit
description: >
  **Feature Commit** — Commit all current work to the local git repository whenever a feature-level version bump (0.X.0) has been made. Triggered automatically after completing any new feature or major change that advances the middle version digit. Creates a clean local checkpoint so progress is never lost and rollback is always available. Does NOT push to remote — local commit only.
---

# Feature Commit

You are performing a local git checkpoint commit. This runs automatically after any feature-level version bump (0.X.0) — meaning a new feature was added or a major change to an existing feature was completed.

## When This Skill Applies

Trigger this skill when:
- A new feature was just implemented (middle version digit advanced, e.g. 0.4.x → 0.5.0)
- A major change to an existing feature was completed (middle digit advanced)
- The user says "commit this" or "save progress" or "checkpoint"
- The user explicitly invokes `/feature-commit`

Do NOT trigger for bug fixes (patch bumps, 0.0.x). Those can accumulate between feature commits.

## Versioning Rules (Reference)

- `0.0.x` — bug fix or small polish. Patch digit increments freely, goes beyond 9 (e.g. 0.5.23 is valid).
- `0.x.0` — new feature OR major change to an existing feature. Middle digit only advances for substantive capability additions, not fixes. Reset patch digit to 0.
- `x.0.0` — major architectural change. Requires explicit user approval before bumping.
- **Numbers never roll over at 9.** 0.5.9 is followed by 0.5.10, not 0.6.0.

## Commit Steps

Follow these steps exactly:

### 1. Check status and diff
Run `git status` and `git diff --stat` to see what has changed. Note which files are new (untracked) vs modified.

### 2. Read the current version
Find the current version from `package.json` (the `"version"` field) or from `CLAUDE.md` (the `Current version` line). This becomes part of the commit message.

### 3. Stage files
Stage all changed and new files that are part of the feature work:
- All modified source files (`src/`, `supabase/`, `tests/`)
- CLAUDE.md
- New component/service/hook/test files
- Migration files
- Memory docs (`docs/superpowers/memory/`)

**Do NOT stage:**
- `.claude/settings.local.json` (local-only, never commit)
- `memory/` directory (local Claude memory, never commit)
- `.env*` files

### 4. Draft the commit message
- First line: `feat(scope): short description vX.Y.Z` — keep under 72 chars
- Body: 3–6 bullet points describing what was built, one per major capability
- Scope: the feature area (e.g. `application-builder`, `rating-engine`, `auth`)
- Use present tense imperative ("add", "implement", "introduce")

Format:
```
feat(scope): description vX.Y.Z

- Bullet describing capability 1
- Bullet describing capability 2
- Bullet describing capability 3

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

### 5. Commit
```bash
git commit -m "$(cat <<'EOF'
feat(scope): description vX.Y.Z

- capability 1
- capability 2
- capability 3

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 6. Verify
Run `git log --oneline -3` to confirm the commit landed. Report the short hash and message back to the user.

## What NOT to Do

- Do NOT run `git push` — local commit only unless user explicitly requests a push
- Do NOT use `git add -A` or `git add .` blindly — review what's being staged first
- Do NOT amend previous commits — always create a new commit
- Do NOT skip the pre-commit hook (`--no-verify`) — if it fails, fix the underlying issue

## After Committing

Tell the user:
- The commit hash (short)
- The version that was captured
- That this is local only, and remind them to push when ready: `! git push -u origin <branch>`
