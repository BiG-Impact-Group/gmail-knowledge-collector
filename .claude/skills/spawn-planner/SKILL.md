---
name: spawn-planner
description: >
  Creates a planner worktree atomically on a NEW plan/<slug> branch (distinct from the
  builder's future feature/<slug>). Branches plan/<slug> from origin/test (or --from-branch),
  writes .claude-agent-role: planner, copies .env, initializes the handoff doc at
  docs/superpowers/handoffs/<slug>.md. Prints the exact launch command for a new terminal.
  Triggers: "spawn planner", "/spawn-planner", "start a planner".
---

# Spawn Planner

**Branch model:** planner worktree owns `plan/<slug>`. Builder later cuts `feature/<slug>` from the same base and `git merge --ff-only origin/plan/<slug>` to absorb the plan. These branches never overlap.

**Worktree path:** auto-derived from the current repo name as `../<repo>-planner-<slug>` (e.g. in the `momentum` repo it becomes `../momentum-planner-<slug>`). Portable across any repo.

## Inputs

- `<feature-slug>` (required) — kebab-case `^[a-z0-9-]+$`
- `--from-branch <branch>` (optional, default `test`) — for stacked epics, pass the predecessor feature branch (e.g. `feature/application-auto-populate`)
- `--allow-untracked-shared` (optional) — proceed even if shared dirs (`docs/superpowers/plans|specs|handoffs`, `memory-bank`, `momentum/memory`) have untracked files

## Pre-flight checks

Refuse to proceed if any fail:

```bash
set -euo pipefail
SLUG="$1"
FROM_BRANCH="${FROM_BRANCH:-test}"
REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"

# Validate slug
if [[ ! "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "🛑 slug must match ^[a-z0-9-]+$ (got: '$SLUG')" >&2
  exit 1
fi

# Clean-enough git state (unless override)
UNTRACKED_SHARED=$(git status --porcelain | awk '/^\?\? (docs\/superpowers\/(plans|specs|handoffs)|memory-bank|momentum\/memory)\//')
if [[ -n "$UNTRACKED_SHARED" && "${ALLOW_UNTRACKED:-0}" != "1" ]]; then
  echo "🛑 Untracked shared-dir files present:"
  echo "$UNTRACKED_SHARED"
  echo "Commit or stash them, or re-run with --allow-untracked-shared."
  exit 1
fi

# NEITHER plan/<slug> NOR feature/<slug> may exist (local or origin).
# If plan exists, planner already spawned. If feature exists, builder already spawned.
for B in "plan/$SLUG" "feature/$SLUG"; do
  if git show-ref --verify --quiet "refs/heads/$B"; then
    echo "🛑 Local branch $B already exists." >&2; exit 1
  fi
  if git ls-remote --exit-code --heads origin "$B" >/dev/null 2>&1; then
    echo "🛑 Remote branch $B already exists on origin." >&2; exit 1
  fi
done

# Worktree path must not exist
WT="../${REPO_NAME}-planner-$SLUG"
if [[ -e "$WT" ]]; then
  echo "🛑 Worktree path $WT already exists." >&2; exit 1
fi

# Fetch base
git fetch origin "$FROM_BRANCH"
```

## Action sequence

```bash
set -euo pipefail

# Create the worktree on a new PLAN branch (not feature!)
git worktree add "$WT" -b "plan/$SLUG" "origin/$FROM_BRANCH"

# Write role and meta files
echo "planner" > "$WT/.claude-agent-role"
cat > "$WT/.claude-agent-meta" <<EOF
role: planner
spawned_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
from_branch: $FROM_BRANCH
planning_branch: plan/$SLUG
future_build_branch: feature/$SLUG
slug: $SLUG
EOF

# Copy env + local settings if present
[[ -f .env ]] && cp .env "$WT/.env"
[[ -f .claude/settings.local.json ]] && mkdir -p "$WT/.claude" && cp .claude/settings.local.json "$WT/.claude/settings.local.json"

# Initialize handoff doc
HPATH="$WT/docs/superpowers/handoffs/$SLUG.md"
mkdir -p "$(dirname "$HPATH")"
cat > "$HPATH" <<EOF
# Planner → Builder Handoff: $SLUG

> Auto-generated. Each entry is a tool call the planner attempted but was blocked.
> Builder must process this in Phase 0.5 of implementation.
>
> Planning branch: plan/$SLUG
> Future build branch: feature/$SLUG (cut from $FROM_BRANCH at handoff; ff-merges plan/$SLUG)

## Status: open
## Plan: docs/superpowers/plans/$(date -u +%Y-%m-%d)-$SLUG.md

## Verification queue

## Implementation queue

## Workflow queue

## Out-of-scope attempts (REVIEW)
EOF

# Report
NEW_SHA=$(git -C "$WT" rev-parse HEAD)
```

## Output

Print exactly (substitute `$SLUG`, `$FROM_BRANCH`, `$NEW_SHA`, absolute worktree path):

```
✅ Planner worktree ready: <absolute-path-to-worktree>
   Planning branch: plan/<slug>  (from origin/<from-branch> @ <sha>)
   Role:            planner
   Handoff:         docs/superpowers/handoffs/<slug>.md (empty)

At handoff, builder will cut feature/<slug> from <from-branch> and
git merge --ff-only origin/plan/<slug> to absorb the plan.

To launch the planner agent, open a new terminal and run:
   cd <absolute-path-to-worktree> && claude

Suggested first message for the new terminal:
   "I'm the planner for <slug>. Begin epic planning for this feature using the team's planning workflow."
```

Also remind the user: this terminal stays on the current branch — nothing has changed here.
