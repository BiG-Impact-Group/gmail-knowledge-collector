---
name: validation-gate
description: >
  Pre-PR validation gate. Runs the full test suite, verifies all GitHub sub-issues
  are closed, confirms the feature branch is current with test, and checks for common
  deployment hazards (new env vars, migrations, edge functions). Produces a go/no-go
  report. Invoke after all implementation and code review fixes are complete, before
  human testing. Triggers: "validation gate", "ready check", "pre-PR check",
  /validation-gate.
---

# Validation Gate

You are running the pre-PR validation gate. This is the final automated checkpoint before human testing and PR creation. Every check must pass or be explicitly acknowledged before proceeding.

## When to Run

- After all work units are implemented and code review fixes are applied
- Before human testing
- When the user invokes `/validation-gate`

## Step 1 — Branch status

```bash
echo "=== Branch ==="
git branch --show-current
echo ""
echo "=== Status ==="
git status
echo ""
echo "=== Uncommitted changes ==="
git diff --stat
```

**Gate:** No uncommitted changes. If there are uncommitted changes, ask the user if they should be committed or stashed before proceeding.

## Step 2 — Base-branch sync check

```bash
git fetch origin test
BEHIND=$(git rev-list --count HEAD..origin/test)
echo "Commits behind test: $BEHIND"
```

**Gate:** If behind test by more than 0 commits, warn the user. Recommend `git merge origin/test` before proceeding. This is advisory — with a single developer workflow, this is usually fine.

## Step 3 — TypeScript type checking

```bash
npm run typecheck 2>&1
```

**Gate:** Must pass with zero errors. Type warnings are acceptable.

## Step 4 — Linting

```bash
npm run lint 2>&1
```

**Gate:** Must pass. Auto-fixable issues should be fixed (`npm run lint -- --fix`), then committed.

## Step 5 — Unit tests

```bash
npm test -- --ci --coverage 2>&1
```

**Gate:** All tests must pass. Report coverage summary. Flag any new files with 0% coverage.

## Step 6 — E2E tests (if applicable)

Check if any E2E tests exist for this feature:
```bash
git diff --name-only $(git merge-base origin/test HEAD)..HEAD -- 'tests/*.spec.ts' | head -20
```

If E2E tests were added or modified:
```bash
npm run test:e2e 2>&1
```

**Gate:** All E2E tests must pass. If E2E tests were NOT added for a feature with user-facing changes, flag this as a gap.

## Step 7 — Build check

```bash
npm run build 2>&1
```

**Gate:** Must build without errors. Warnings should be reviewed — new warnings introduced by this feature should be noted.

## Step 8 — GitHub issues check

```bash
# List all work-unit issues for this epic
gh issue list --label work-unit --state open --search "<epic name>" 2>&1
```

**Gate:** All work-unit sub-issues should be closed. List any that remain open and ask the user to confirm they're intentionally deferred.

## Step 9 — Deployment hazard scan

Scan for things that will need attention during deployment:

```bash
echo "=== New migrations ==="
git diff --name-only $(git merge-base origin/test HEAD)..HEAD -- 'supabase/migrations/*'

echo ""
echo "=== New/modified edge functions ==="
git diff --name-only $(git merge-base origin/test HEAD)..HEAD -- 'supabase/functions/*'

echo ""
echo "=== New environment variables ==="
git diff $(git merge-base origin/test HEAD)..HEAD -- '.env*' 'supabase/functions/*' | grep -E '(process\.env|Deno\.env|SUPABASE_|OPENAI_|ANTHROPIC_)' | head -20

echo ""
echo "=== New dependencies ==="
git diff $(git merge-base origin/test HEAD)..HEAD -- 'package.json' | grep '^\+.*":'  | grep -v '"version"' | head -20
```

Report each finding clearly. These don't block the gate but must be documented for the PR.

## Step 9.5 — Migration target check (FAIL-CLOSED)

If Step 9 surfaced any new migration files, verify they would land on the correct Supabase project. **This is a hard gate — failure blocks the PR.**

```bash
NEW_MIGRATIONS=$(git diff --name-only $(git merge-base origin/test HEAD)..HEAD -- 'supabase/migrations/*' | wc -l | tr -d ' ')

if [ "$NEW_MIGRATIONS" -gt 0 ]; then
  LINKED_REF=$(cat supabase/.temp/project-ref 2>/dev/null || echo "MISSING")
  echo "=== Linked Supabase project ==="
  echo "$LINKED_REF"

  if [ "$LINKED_REF" != "SUPABASE_PROJECT_REF_PLACEHOLDER" ]; then
    echo ""
    echo "❌ FAIL — linked project ref does not match this project."
    echo "All migrations must target the gmail-knowledge-collector Supabase project."
    echo "Run: supabase link --project-ref SUPABASE_PROJECT_REF_PLACEHOLDER"
    exit 1
  fi
fi
```

**Gate:** If new migrations are present, `supabase/.temp/project-ref` MUST match this project's Supabase project ref. See `docs/dev-rules-local-overrides.md` item 4 for the ref value. Re-link if the gate fails: `supabase link --project-ref <ref>`.

If this gate fails, do NOT proceed to PR. Re-link to the correct project, re-verify, and re-run the gate.

## Step 10 — Generate report

Produce a summary report:

```
## Validation Gate Report — <epic name>
**Branch:** feature/<slug>
**Date:** YYYY-MM-DD

| Check | Status | Notes |
|---|---|---|
| Branch clean | ✅/❌ | |
| Dev sync | ✅/⚠️ | X commits behind |
| TypeScript | ✅/❌ | X errors |
| Lint | ✅/❌ | |
| Unit tests | ✅/❌ | X passed, Y failed, Z% coverage |
| E2E tests | ✅/❌/⏭️ | |
| Build | ✅/❌ | |
| Issues closed | ✅/⚠️ | X open |

### Deployment hazards
- [ ] Migrations: <list or "none">
- [ ] Edge functions: <list or "none">
- [ ] Env vars: <list or "none">
- [ ] Dependencies: <list or "none">

### Verdict: PASS / FAIL / PASS WITH WARNINGS
```

Save the report to disk (do NOT commit — it will be included in the PR):
```bash
cat > docs/superpowers/plans/YYYY-MM-DD-<slug>-validation-report.md << 'EOF'
<report content>
EOF
```

## What NOT to do

- Do NOT skip failing tests — every failure must be addressed or explicitly deferred
- Do NOT auto-fix and commit without telling the user what was changed
- Do NOT proceed to PR if any Critical gate fails (typecheck, unit tests, build)

## After Validation

If **FAIL**: List the failures and tell the user what needs to be fixed before re-running the gate.

If **PASS**: Tell the user "Validation gate passed. Proceed to human testing, then run `/pr-package` to create the PR."

**Print the inputs for the next step on the screen** for the human to reference when invoking `/pr-package` after manual testing:
- **Feature branch:** (use actual branch name)
- **Epic name:** (use actual epic name)
- **Plan path:** (use actual path)
- **GitHub epic issue:** #<number> (use actual issue number)
- **Validation report path:** `docs/superpowers/plans/YYYY-MM-DD-<slug>-validation-report.md` (use actual path)
- **Deployment hazards found:** (list any migrations, edge functions, env vars, or deps flagged)
