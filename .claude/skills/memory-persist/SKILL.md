---
name: memory-persist
description: >
  Creates a comprehensive memory doc for a completed feature epic and commits it to the
  repo. Reads the plan, all review artifacts, the implementation diff, and synthesizes
  a technical reference document in docs/superpowers/memory/. Invoke after a feature PR
  is merged. Triggers: "write memory doc", "persist knowledge", "create memory", /memory-persist.
---

# Memory Persist

You are creating the institutional memory for a completed feature epic. This document will be the primary reference for anyone who works on this feature in the future — including future Claude sessions. It must be comprehensive, accurate, and follow the established format.

## When to Run

- After the feature PR is merged to test
- When the user invokes `/memory-persist`

## Step 1 — Gather all artifacts

Read everything related to this epic:

```bash
# Find plan and review artifacts
ls -la docs/superpowers/plans/*<slug>*

# Recent commits for this feature
MERGE_BASE=$(git merge-base test HEAD 2>/dev/null || git merge-base origin/test HEAD)
git log --oneline $MERGE_BASE..HEAD

# Files changed
git diff --name-only $MERGE_BASE..HEAD

# Existing memory docs (for format reference)
ls docs/superpowers/memory/
```

If existing memory docs are present, read one to understand the expected format and depth.

## Step 2 — Read all source artifacts

Read in full:
1. The plan file (`docs/superpowers/plans/YYYY-MM-DD-<slug>.md`)
2. The Codex plan review (`*-codex-review.md`) if it exists
3. The Codex code review (`*-codex-code-review.md`) if it exists
4. The validation report (`*-validation-report.md`) if it exists

## Step 3 — Analyze the implementation

For each major area of change, read the actual source files to understand what was built:

```bash
# List all changed files by directory
MERGE_BASE=$(git merge-base test HEAD 2>/dev/null || git merge-base origin/test HEAD)
git diff --name-only $MERGE_BASE..HEAD | sort | head -50
```

Read the key files — focus on:
- New components and their props/behavior
- New services and their public API
- New hooks and what they provide
- Database migrations (exact schema)
- Edge functions (what they do, what they call)
- New types/interfaces

## Step 4 — Write the memory doc

Create the memory doc following this structure:

```markdown
# <Feature Name> — Feature Documentation

## Overview
<2-3 paragraphs: what this feature does, why it was built, who it serves>

## Architecture

### System diagram
<Describe the data flow: user action → component → service → database/API → response>

### Key components
| Component | Location | Purpose |
|---|---|---|
| <Name> | `src/components/...` | <What it does> |

### Key services
| Service | Location | Purpose |
|---|---|---|
| <Name> | `src/services/...` | <What it does> |

### Database tables
| Table | Purpose | Key columns |
|---|---|---|
| <name> | <purpose> | <important columns> |

### Edge functions
| Function | Purpose | Triggers |
|---|---|---|
| <name> | <purpose> | <when it runs> |

## Implementation details

### <Major capability 1>
<How it works in detail — enough for a developer to understand and modify>

### <Major capability 2>
<How it works in detail>

## Security

- RLS policies: <what's enforced>
- Auth requirements: <who can access what>
- User isolation: <how it's implemented — (select auth.uid()) pattern>
- Token safety: <how OAuth tokens are protected>

## Testing
- Unit tests: <where they are, what they cover>
- E2E tests: <where they are, what flows they test>
- Key test scenarios: <list the most important test cases>

## Configuration
- Environment variables: <any new ones>
- Supabase Vault secrets: <any new secrets stored in Vault>
- Feature flags: <any toggles>

## Known limitations & future work
- <Things that were descoped or deferred>
- <Known edge cases not yet handled>
- <Planned improvements from code review>

## Related features
- <Links to other memory docs that interact with this feature>

## Revision history
| Date | Change | Author |
|---|---|---|
| YYYY-MM-DD | Initial documentation | Claude + <user> |
```

## Step 5 — Save the memory doc

```bash
# Write to docs/superpowers/memory/
# Filename format: kebab-case-feature-documentation.md
cat > docs/superpowers/memory/<feature-slug>-feature-documentation.md << 'EOF'
<memory doc content>
EOF
```

## Step 6 — Update CLAUDE.md

Add an entry to the Feature Memory table in CLAUDE.md:

```
| `docs/superpowers/memory/<feature-slug>-feature-documentation.md` | <Feature Name> | <Key areas> |
```

## Step 7 — Commit

```bash
git add docs/superpowers/memory/<feature-slug>-feature-documentation.md CLAUDE.md
git commit -m "docs: add memory doc for <feature name>"
```

## Step 8 — Verify

```bash
# Confirm the file exists and has content
wc -l docs/superpowers/memory/<feature-slug>-feature-documentation.md

# Confirm it's committed
git log --oneline -3
```

Report to the user:
- Memory doc path and size
- Commit SHA
- Any cross-references to existing memory docs that should be updated

## What NOT to do

- Do NOT write a shallow summary — this doc must be detailed enough that a developer can understand and modify the feature without reading the source code
- Do NOT skip database schema details — exact column names and types matter
- Do NOT omit security details — RLS policies and token safety are critical
- Do NOT forget to update CLAUDE.md — the feature memory table is how future sessions find this doc

## Quality check

Before finishing, verify the memory doc answers these questions:
1. What does this feature do? (user perspective)
2. How is it built? (architecture)
3. Where is everything? (file locations)
4. How is it secured? (RLS, token safety, auth)
5. How is it tested? (test locations, key scenarios)
6. What's not done yet? (limitations, future work)

If any answer is missing or vague, go back and fill it in.

## Workflow complete

This is the final step (step 10) of the epic development workflow. After this skill runs, the epic lifecycle is complete.

**Print a summary for the human:**
- **Epic name:** (use actual epic name)
- **PR:** #<number> — <URL> (use actual)
- **Memory doc:** `docs/superpowers/memory/<slug>-feature-documentation.md` (use actual path)
- **Workflow status: COMPLETE** — all 10 steps finished
