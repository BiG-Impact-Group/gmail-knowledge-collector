---
name: pr-package
description: >
  Packages a completed feature epic into a comprehensive pull request. Inspects the full
  diff against test, compiles all commit history, references the plan and validation report,
  flags deployment hazards (migrations, edge functions, secrets, env vars), and creates
  a draft PR against test. Invoke after human testing is complete. Triggers: "create PR",
  "package PR", "ship this", "pr-package", /pr-package.
---

# PR Package

You are creating a comprehensive pull request for a completed feature epic. The PR must give the team everything they need to merge safely. PRs target `test`; merging to `main` is a separate human-driven promotion step.

## When to Run

- After human testing is complete
- After the validation gate has passed
- When the user invokes `/pr-package`

## Step 1 — Gather context

Run these in parallel to understand the full scope:

```bash
# Current branch and status
git branch --show-current
git status

# All commits in this feature
MERGE_BASE=$(git merge-base test HEAD)
git log --oneline $MERGE_BASE..HEAD

# Full diff stats
git diff --stat $MERGE_BASE..HEAD

# Files changed
git diff --name-only $MERGE_BASE..HEAD
```

Read the plan file and validation report:
```bash
ls -t docs/superpowers/plans/*.md | head -10
```

## Step 2 — Identify deployment concerns

Scan for everything that will affect the merge and promotion process:

### Migrations
```bash
git diff --name-only $MERGE_BASE..HEAD -- 'supabase/migrations/*'
```
For each migration, read it and note:
- New tables (will they conflict with anything on dev/test/main?)
- Column additions (IF NOT EXISTS used?)
- RLS policies (complete for all operations?)
- Indexes added
- Data migrations vs schema-only

### Edge Functions
```bash
git diff --name-only $MERGE_BASE..HEAD -- 'supabase/functions/*'
```
For each function, note:
- New function or update to existing?
- New secrets/env vars required?
- Breaking API changes?

### Environment Variables
```bash
git diff $MERGE_BASE..HEAD -- 'supabase/functions/*' '.env*' | grep -E '(Deno\.env\.get|process\.env\.)' | sort -u
```

### New Dependencies
```bash
git diff $MERGE_BASE..HEAD -- 'package.json' | grep '^\+'  | grep -v '"version"' | head -20
```

## Step 3 — Compile issue references

```bash
# Find the epic issue
gh issue list --label epic --state all --search "<epic name>" --json number,title,state

# Find all work unit issues
gh issue list --label work-unit --state all --search "<epic name>" --json number,title,state
```

## Step 4 — Push the branch

```bash
git push -u origin $(git branch --show-current)
```

## Step 5 — Create the PR

Draft the PR body and create it:

```bash
gh pr create --title "<type>(<scope>): <concise description>" --body "$(cat <<'EOF'
## Summary

<2-3 sentence overview of what this epic delivers and why it matters>

**Epic:** #<epic-issue-number>
**Plan:** `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`

## What changed

<Organized by area — not a raw file list. Group related changes:>

### <Area 1, e.g., "Database">
- <What was added/changed and why>

### <Area 2, e.g., "UI Components">
- <What was added/changed and why>

### <Area 3, e.g., "Services / Business Logic">
- <What was added/changed and why>

## Work units completed

- [x] #<issue> — Unit 1: <name>
- [x] #<issue> — Unit 2: <name>
- [x] #<issue> — Unit N: <name>

## Deployment checklist

### Migrations
<For each migration, in order:>
- [ ] `YYYYMMDDHHMMSS_<name>.sql` — <what it does, any special notes>

### Edge Functions
- [ ] <function name> — <new/updated, what it does>

### Environment Variables / Secrets
- [ ] `VAR_NAME` — <where to set it, what it's for>
  - Required in: <dev / test / main>

### Dependencies
- [ ] <package@version> — <why added>

### Promotion notes (test → main)
<Anything the devops team needs to know about promoting this:>
- <Order of operations (e.g., "run migrations before deploying edge functions")>
- <Feature flags to enable/disable>
- <Data backfill steps if any>
- <Rollback procedure if something goes wrong>

## Testing

### Automated
- Unit tests: <X passing, Y% coverage on new code>
- E2E tests: <X passing / not applicable>
- Validation gate: PASS (see `docs/superpowers/plans/*-validation-report.md`)

### Manual
<What was tested manually during human testing:>
- [ ] <scenario 1>
- [ ] <scenario 2>

## Review process

- [x] Codex independent plan review (`docs/superpowers/plans/*-codex-review.md`)
- [x] Codex adversarial code review (`docs/superpowers/plans/*-codex-code-review.md`)
- [x] Validation gate passed
- [x] Human testing complete

## Screenshots

<If UI changes, add before/after screenshots here>

EOF
)"
```

## Step 6 — Report

After the PR is created, report:
- PR URL
- PR number
- Summary of deployment concerns
- Any open issues or known limitations

## What NOT to do

- Do NOT create the PR without pushing the branch first
- Do NOT skip the deployment checklist — this is the most important part for devops
- Do NOT create a PR if the validation gate hasn't passed
- Do NOT merge the PR — that's for devops after review

## After PR Creation

Tell the user: "PR created. The deployment checklist is included. After the PR merges to test, run `/memory-persist` to create the memory doc."

**Print the inputs for the next step on the screen** for the human to reference when invoking `/memory-persist`:
- **PR URL:** (use actual URL)
- **PR number:** #<number> (use actual number)
- **Feature branch:** (use actual branch name)
- **Epic name:** (use actual epic name)
- **Plan path:** (use actual path)
