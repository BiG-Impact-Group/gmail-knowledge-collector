---
name: spawn-builder
description: >
  Two modes. No args: declares the current worktree as builder (writes .claude-agent-role: builder
  and re-registers). With <feature-slug>: creates a new builder worktree at ../<repo>-builder-<slug>
  by cutting feature/<slug> from --from-branch (default test) and ff-merging origin/plan/<slug> to
  absorb the plan artifacts. Triggers: "spawn builder", "/spawn-builder", "declare builder".
---

# Spawn Builder

**Branch model:** builder worktree owns `feature/<slug>`, cut fresh from the base at spawn time, with `origin/plan/<slug>` ff-merged to absorb plan artifacts. Planner keeps its own `plan/<slug>` worktree alive for mid-build revisions (which flow through `plan-rev/<slug>-rN` branches).

**Worktree path:** auto-derived from the current repo name as `../<repo>-builder-<slug>` (e.g. in the `momentum` repo it becomes `../momentum-builder-<slug>`). Portable across any repo.

## Mode A — declare current worktree as builder (no args)

Use this when you want to mark the current checkout as the builder without creating a new worktree (solo mode, or adopting an existing worktree).

```bash
set -euo pipefail
echo "builder" > .claude-agent-role
cat > .claude-agent-meta <<EOF
role: builder
declared_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

# Optional: register with the agent manifest if the team has it set up.
# These files are not required for the skill to function.
if [[ -f .claude/lib/agent-manifest.sh ]]; then
  source .claude/lib/agent-manifest.sh
  manifest_deregister "$$" 2>/dev/null || true
fi
[[ -x .claude/hooks/agent-register.sh ]] && .claude/hooks/agent-register.sh

echo "✅ Current worktree declared as builder. Role file written."
```

## Mode B — create a new builder worktree (slug provided)

### Inputs

- `<feature-slug>` (required) — kebab-case `^[a-z0-9-]+$`
- `--from-branch <branch>` (optional, default `test`) — base to cut `feature/<slug>` from. For stacked epics, pass the predecessor feature branch (e.g. `feature/application-auto-populate`).

### Pre-flight checks

```bash
set -euo pipefail
SLUG="$1"
FROM_BRANCH="${FROM_BRANCH:-test}"
REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
WT="../${REPO_NAME}-builder-$SLUG"

# Validate slug
if [[ ! "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
  echo "🛑 slug must match ^[a-z0-9-]+$ (got: '$SLUG')" >&2
  exit 1
fi

# Target path must not exist
if [[ -e "$WT" ]]; then
  echo "🛑 Worktree path $WT already exists." >&2; exit 1
fi

# feature/<slug> must NOT exist yet (we're creating it)
if git show-ref --verify --quiet "refs/heads/feature/$SLUG"; then
  echo "🛑 Local branch feature/$SLUG already exists — builder may have spawned already." >&2; exit 1
fi
if git ls-remote --exit-code --heads origin "feature/$SLUG" >/dev/null 2>&1; then
  echo "🛑 Remote branch feature/$SLUG already exists — builder may have spawned already." >&2; exit 1
fi

# plan/<slug> MUST exist on origin (planner has finished + pushed)
git fetch origin "plan/$SLUG" 2>/dev/null || true
if ! git ls-remote --exit-code --heads origin "plan/$SLUG" >/dev/null 2>&1; then
  echo "🛑 Remote branch plan/$SLUG does not exist on origin." >&2
  echo "   The planner must finish and push plan/$SLUG before the builder can spawn." >&2
  echo "   (If this is a solo-mode build with no planner, use Mode A on an existing worktree instead.)" >&2
  exit 1
fi

# from-branch must exist on origin
git fetch origin "$FROM_BRANCH"
if ! git show-ref --verify --quiet "refs/remotes/origin/$FROM_BRANCH"; then
  echo "🛑 Remote branch $FROM_BRANCH does not exist on origin." >&2; exit 1
fi

# A planner worktree on plan/<slug> is EXPECTED — note, don't warn.
if [[ -d "../${REPO_NAME}-planner-$SLUG" ]]; then
  echo "ℹ️  Planner worktree detected at ../${REPO_NAME}-planner-$SLUG on plan/$SLUG."
  echo "   That's normal and expected — you'll keep it alive for mid-build plan revisions."
fi
```

### Action sequence

```bash
set -euo pipefail

# 1. Create the builder worktree on a fresh feature/<slug> branch cut from the base.
git worktree add "$WT" -b "feature/$SLUG" "origin/$FROM_BRANCH"

# 2. Absorb the plan artifacts via ff-merge (plan/<slug> must be strictly ahead of, or equal to, origin/<from-branch>).
git -C "$WT" fetch origin "plan/$SLUG"
if ! git -C "$WT" merge --ff-only "origin/plan/$SLUG"; then
  echo "🛑 ff-merge of origin/plan/$SLUG into feature/$SLUG failed." >&2
  echo "   plan/$SLUG may have diverged from $FROM_BRANCH. Planner must rebase plan/$SLUG onto origin/$FROM_BRANCH before spawning the builder." >&2
  git worktree remove "$WT" --force
  git branch -D "feature/$SLUG"
  exit 1
fi

# 3. Push the new feature branch so it's visible to CI and to the planner for future plan-rev diffing.
git -C "$WT" push -u origin "feature/$SLUG"

# 4. Role + meta files.
echo "builder" > "$WT/.claude-agent-role"
cat > "$WT/.claude-agent-meta" <<EOF
role: builder
spawned_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
from_branch: $FROM_BRANCH
build_branch: feature/$SLUG
plan_branch_absorbed: plan/$SLUG
slug: $SLUG
EOF

# 5. Copy env + local settings if present.
[[ -f .env ]] && cp .env "$WT/.env"
[[ -f .claude/settings.local.json ]] && mkdir -p "$WT/.claude" && cp .claude/settings.local.json "$WT/.claude/settings.local.json"

NEW_SHA=$(git -C "$WT" rev-parse HEAD)
PLAN_SHA=$(git -C "$WT" rev-parse "origin/plan/$SLUG")
```

### Output (Mode B)

Substitute `<repo>` with `$REPO_NAME`, `<slug>` with `$SLUG`, etc.:

```
✅ Builder worktree ready: <absolute-path-to-worktree>
   Implementation branch: feature/<slug>  (cut from origin/<from-branch>)
   Plan absorbed:         origin/plan/<slug> @ <plan-sha>  (ff-merged)
   HEAD:                  <new-sha>
   Role:                  builder

The planner worktree at ../<repo>-planner-<slug> stays alive on plan/<slug>
for mid-build revisions. If a plan gap surfaces during implementation, the
planner will cut plan-rev/<slug>-rN from your current tip, commit the fix,
push, and ask you to:
   git fetch origin && git merge --ff-only origin/plan-rev/<slug>-rN

Launch the builder agent with:
   cd <absolute-path-to-worktree> && claude

Suggested first message:
   "I'm the builder for <slug>. Begin implementation using the team's plan implementation workflow."
```
