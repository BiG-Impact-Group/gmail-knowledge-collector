---
name: version-and-commit
description: >
  Bumps the app version in src/version.ts and commits changes with a meaningful
  conventional commit message. Fires at natural commit points — after completing
  a bug fix, feature, refactor, or any logical unit of work.
---

# Version and Commit

You are the version manager and release scribe. Your job is to create clean,
meaningful git commits at natural breakpoints — the same moments a senior
developer would commit.

## When to Run

Invoke this skill at **natural commit points**, not after every edit. Think like
a developer:

| Commit NOW | Do NOT commit yet |
|---|---|
| Bug fix is complete and verified | Mid-way through a multi-file change |
| Feature or logical chunk of work is done | Just edited one file of several that need changing |
| Refactor is finished and types still pass | Still debugging / iterating on a fix |
| About to switch context to a different task | User is still giving instructions for the current task |
| User explicitly asks to commit | Conversation is still going on the same topic |
| Session is ending and there are uncommitted changes | Nothing has changed since last commit |

**Rule of thumb:** if you'd write a meaningful one-line description of what
changed, it's time to commit. If the best you can do is "work in progress" or
"bump version", keep working.

## Step 1 — Check for Changes

```bash
git status --porcelain
```

If there are no changes, stop — do not create empty commits.

## Step 2 — Determine Bump Type

Examine what was done since the last commit:

| Change type | Bump | Example |
|---|---|---|
| Bug fix, typo, styling tweak, config change | **patch** (0.0.X) | `0.13.1 → 0.13.2` |
| New feature, new component, new page, new service | **minor** (0.X.0), resets patch to 0 | `0.13.2 → 0.14.0` |
| Major architectural change | **major** — only if user explicitly says so | `0.14.0 → 1.0.0` |

This is pre-release software (major = 0), so:
- **Minor** = new capability visible to users
- **Patch** = everything else (fixes, refactors, chore, docs, tests)

Patch numbers go beyond 9 freely (0.13.9 → 0.13.10, not 0.14.0).

## Step 3 — Update version.ts

Read `src/version.ts`, apply the bump, write it back:

```typescript
export const APP_VERSION = '0.13.2';
```

Also update the `BUILDER_VERSION` const in
`src/components/product/application-builder/FormStructureTree.tsx` to match.

## Step 4 — Write a Meaningful Commit Message

Follow the conventional commit format from `momentum/arch/GIT_WORKFLOW.md`:

```
type(scope): short description of what changed

Optional body — explain the "why" if not obvious from the description.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

### Types

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `chore` | Build config, deps, tooling |
| `docs` | Documentation only |
| `style` | Formatting, no logic change |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `ci` | CI/CD pipeline changes |

### Rules

- **The subject line describes the actual change**, not the version bump.
  Good: `fix(routing): add missing application builder route`
  Bad: `chore: bump version to 0.13.2`
- Keep subject under 70 characters.
- Scope should be the area touched (e.g., `routing`, `endorsements`, `auth`, `db`).
- If multiple logical changes were made, pick the primary one for the subject
  and list the rest in the body.

## Step 5 — Stage and Commit

Stage specific files — do NOT use `git add -A`. Review what's being staged:

```bash
git add <specific files that changed>
git commit -m "$(cat <<'EOF'
type(scope): description

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Do NOT use `--no-verify`. If pre-commit hooks fail, fix the issue.

## Step 6 — Confirm

After committing, output a brief summary:

---

**Committed: `type(scope): description`** (v X.Y.Z)

- What changed and why, in plain English

---
