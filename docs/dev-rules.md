# Momentum — Development Rules & CLI Workflow

**Drafted: 2026-05-11**

Please add comments inline (or reply with corrections). Anything marked ✓ is already encoded in Claude's instructions. Anything wrong or out-of-date should be struck through and corrected.

---

## Part 1 — CLI Development Workflow (Step-by-Step)

The concrete commands builder runs for each new feature, in order.

### Setup: Start a fresh session

Every new feature starts in a **new terminal + new Claude Code session** — no carryover context.

```bash
# 1. Confirm you are in the right repo
pwd
# Expected: /c/Users/avigi/Code/momentum-rv  (NOT the Dropbox path)

# 2. Confirm you are on the right branch (should be test or a feature branch)
git branch --show-current

# 3. Confirm the repo is clean
git status
```

### Setup: Sync to latest test, then spawn a planner worktree

Planning (Steps 1–4) happens in an isolated **planner** worktree on a `plan/<slug>` branch cut from `origin/test`. Do NOT hand-roll the branch with `git checkout -b` — use the spawn skill, which atomically creates the worktree, writes `.claude-agent-role: planner`, copies `.env` + `.claude/settings.local.json`, and initializes the handoff doc at `docs/superpowers/handoffs/<slug>.md`.

```bash
# Pull latest test before cutting anything
git checkout test
git pull origin test
```

```
# Spawn the planner worktree (creates plan/<slug> from origin/test)
/spawn-planner <slug>
```

This prints the exact launch command for a new terminal. Open that terminal, run the printed command to start the planner session, then proceed to Step 1 inside the planner worktree.

> **Branch contract:** the planner owns `plan/<slug>`; the builder (spawned before Step 5) owns a separate `feature/epic-NN-<slug>`. The two branches never overlap — the builder absorbs the planner's artifacts via a fast-forward merge of `origin/plan/<slug>`.

---

### Step 1 — Epic Kickoff & Brainstorm

Invoke the brainstorm skill. Claude asks clarifying questions one at a time, proposes 2–3 approaches, and presents a design for approval.

```
/brainstorm
```

**Artifact:** Write the agreed spec to `docs/superpowers/plans/YYYY-MM-DD-<slug>-design.md` and commit it:

```bash
git add docs/superpowers/plans/YYYY-MM-DD-<slug>-design.md
git commit -m "docs(epic-NN): add spec for <slug>"
```

---

### Step 2 — Decomposition

Break the spec into discrete work units and create GitHub issues.

```bash
# Create the epic issue
gh issue create --title "Epic NN — <name>" --body "<description>"

# Create sub-issues for each unit of work
gh issue create --title "<unit of work>" --body "Part of Epic NN"
```

---

### Step 3 — Codex Plan Review

Run Codex against the plan. Iterate until 0 CRITICALs (typically 2–5 rounds).

```
/codex-plan-review
```

**Artifact:** Save each round to `docs/superpowers/plans/YYYY-MM-DD-<slug>-codex-plan-review-vN.md`

```bash
git add docs/superpowers/plans/
git commit -m "docs(epic-NN): codex plan review vN"
```

Do not proceed to Step 4 with any open CRITICALs.

---

### Step 4 — Plan Finalization

Apply Codex feedback. Update the spec, revise GitHub issues if scope changed, bump the revision history table in the spec file.

```bash
git add docs/superpowers/plans/YYYY-MM-DD-<slug>-design.md
git commit -m "docs(epic-NN): finalize plan post-codex-review"
```

---

### Step 4.5 — Spawn a builder worktree

Once the plan is finalized and committed, hand off from the **planner** worktree to a fresh **builder** worktree. Implementation (Steps 5–9) happens here, on a `feature/epic-NN-<slug>` branch — never in the planner worktree.

First push the planner's branch so the builder can absorb it:

```bash
# In the planner worktree — publish the finalized plan
git push -u origin plan/<slug>
```

Then spawn the builder. The skill creates the worktree at `../<repo>-builder-<slug>`, cuts `feature/epic-NN-<slug>` from `test` (the base, default), ff-merges `origin/plan/<slug>` to pull in all planning artifacts, writes `.claude-agent-role: builder`, and pushes the new feature branch to origin.

```
# Spawn the builder worktree (cuts feature/epic-NN-<slug> from test, absorbs the plan)
/spawn-builder epic-NN-<slug>
```

Open the new terminal it prints, launch the builder session there, and do all implementation in that worktree. Keep the planner worktree alive during the build — mid-build plan revisions flow through `plan-rev/<slug>-rN` branches from the planner, not from the builder.

---

### Step 5 — Implementation

Run the dev server:

```bash
npm run dev
# App available at http://127.0.0.1:8081
```

Work through each sub-issue. Commit at natural breakpoints:

```bash
git add <specific-files>   # Never: git add -A or git add .
git commit -m "feat(scope): description"
```

If you add a migration:

```bash
# 1. Create via CLI — never manually
npx supabase migration new your_description_here

# 2. Edit the generated file in supabase/migrations/
# 3. Test in a transaction
npm run db:psql
# psql> BEGIN;
# psql> \i supabase/migrations/<timestamp>_your_description.sql
# psql> ROLLBACK;

# 4. Apply to cloud DB
npx supabase db push --linked

# 5. Verify it appears in Remote column
npx supabase migration list --linked

# 6. Regenerate TypeScript types
npm run gen:types

# 7. Commit both
git add supabase/migrations/ src/types/database.types.ts
git commit -m "feat(scope): add migration + regen types"
```

**Smoke test after each sub-issue:**

1. Hard-reload the page in browser
2. Click into the new functionality once
3. Verify it visibly does what the spec says
4. Open DevTools Console — confirm no red errors

---

### Step 6 — Codex Code Review

Run Codex against the full diff. Iterate until 0 CRITICALs.

```
/codex-code-review
```

**Artifact:** Save each round to `docs/superpowers/plans/YYYY-MM-DD-<slug>-codex-code-review-vN.md`

```bash
git add docs/superpowers/plans/
git commit -m "docs(epic-NN): codex code review vN"
```

Do not proceed to Step 7 with any open CRITICALs.

---

### Step 7 — Code Review Triage

Fix every CRITICAL and IMPORTANT finding from Step 6. Commit the fixes:

```bash
git add <specific-files>
git commit -m "fix(scope): address codex code review findings"
```

If fixes are substantial, re-run `/codex-code-review` before proceeding.

---

### Step 8 — Validation Gate

```bash
# TypeScript
npm run build

# Lint
npm run lint

# Unit tests
npm test

# Confirm migration gate — every migration in this branch must appear in Remote
npx supabase migration list --linked
```

Run the validation gate skill for a formal report:

```
/validation-gate
```

**Artifact:** `docs/superpowers/plans/YYYY-MM-DD-<slug>-validation-report.md`

Do not proceed to Step 9 with any failures.

---

### Step 9 — Human Testing + PR

Smoke test the full epic in the browser. Then write the PR body to a file and open the PR:

```bash
# Write PR body to a file first (never paste from chat)
cat > docs/superpowers/plans/YYYY-MM-DD-<slug>-pr-body.md << 'EOF'
## Summary
...

## Test plan
...
EOF

# Push branch to origin
git push -u origin $(git branch --show-current)

# Open PR — always against test, never main
gh pr create --draft --base test --body-file docs/superpowers/plans/YYYY-MM-DD-<slug>-pr-body.md --title "feat(scope): <title>"
```

---

### Step 10 — Knowledge Persistence

After the PR merges:

```bash
# Apply migrations to the test DB (if this epic had migrations)
npx supabase link --project-ref iwpckxvgpdmglfrngrkr
npx supabase db push --linked
npx supabase migration list --linked   # confirm new timestamp appears as applied

# Delete local feature branch (it's in git history; keeping it causes confusion)
git checkout test
git pull origin test
git branch -d feature/epic-NN-short-description
```

Run the memory persistence skill to document the feature:

```
/memory-persist
```

**Artifact:** Memory doc in `momentum/memory/` + wiki sync.

---

## Part 2 —  Rules (Synthesized)

These are rules captured directly from calls and messages, organized by topic.

---

### Git & Branch Hygiene

*(Source: call, 2026-05-11)*

1. **Always pull latest `test` before starting any new development.** Never start a feature branch from a stale base.
2. **Always cut feature branches from `test`.** New features must layer on top of wherever `test` currently is.
3. **Delete local feature branches after the PR merges.** The branch lives in git history; keeping it locally causes confusion and risks working from outdated code.
4. **Start each new feature in a fresh Claude session.** Open a new terminal with no memory context from prior work. Carrying over context causes stale assumptions.
5. **Verify your working directory at the start of every session.** Confirm the correct repo path and branch before doing anything.
6. **Never push directly to `main` or `test`.** All work goes through feature branches and PRs.
7. **Branch naming:** `feature/epic-NN-<slug>`, cut from `test`, merged back to `test` via PR.
8. **Commit format:** `type(scope): description` (e.g. `feat(auth): add SSO`).
9. **Use the worktree spawn skills — never hand-roll branches.** Planning runs in a planner worktree (`/spawn-planner <slug>` → `plan/<slug>`); implementation runs in a separate builder worktree (`/spawn-builder epic-NN-<slug>` → `feature/epic-NN-<slug>`, which ff-merges `origin/plan/<slug>`). The planner and builder branches never overlap, and the planner worktree stays alive through the build for plan revisions (`plan-rev/<slug>-rN`).

---

### Supabase Environment

*(Source: call, 2026-05-11)*

- The **test environment must point to the Supabase `main` branch**, not a test branch. Schema and data mismatches occur when the Netlify test deploy is wired to a Supabase branch instead of the main project. Verify this if the app behaves unexpectedly in the test environment.

---

### One PR per Epic

*(Source: call, 2026-04-30)*

**A pull request maps 1:1 to an epic, never to a slice.** Multiple slices within the same epic land in the SAME PR.

Reasoning: PR review time is expensive and UAT is harder when fragmented across multiple PRs. One PR per epic means he reviews the whole feature once.

**Structure:**

- One **GitHub Epic Issue** per epic (e.g. "Epic 07 — Pipeline Detail")
- Multiple **sub-issues** per epic, each representing a unit of work
- One **feature branch** per epic: `feature/epic-NN-<slug>`
- One **PR** per epic, opened as draft against `test`

**Inner loop within a multi-slice epic:**

- Slice 1: brainstorm → plan → Codex plan review → implement → Codex code review → triage → fast UAT → commit. **Do NOT open the PR yet.**
- Slice 2+: repeat on the same branch.
- After the last slice: validation gate → full epic UAT → open single PR.

---

### ⛔ Migration Deploy Gate (MANDATORY)

**Why this rule exists:** In May 2026, 47 migrations silently piled up over 3 months. Migration files were merged into `test` and `main` without ever being applied to the shared Supabase DB. The Supabase Preview CI check only validates against an ephemeral preview DB — it does NOT update the shared production DB. The fix took hours.

**The rule:** Any PR that adds or modifies files under `supabase/migrations/` **must** have those migrations applied to the linked DB before the PR is opened. This is a precondition, not a post-merge step.

**Verification command — must run before opening any PR:**

```bash
npx supabase migration list --linked
# Every migration added in this branch must appear in BOTH Local and Remote columns.
# If any row shows Local only (no Remote timestamp), STOP — apply it first.
```

**Always write idempotent SQL:**

```sql
-- Good
CREATE TABLE IF NOT EXISTS my_table (...);
ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_col text;

-- Bad
CREATE TABLE my_table (...);
```

**Never edit an already-applied migration.** Create a new one to fix mistakes.

---

### The 10-Step Epic Workflow


| Step | Name                      | Artifact                                     |
| ---- | ------------------------- | -------------------------------------------- |
| 1    | Epic Kickoff & Brainstorm | Plan in `docs/superpowers/plans/`            |
| 2    | Decomposition             | Work units + GitHub sub-issues               |
| 3    | Codex Plan Review         | Review artifact (`*-codex-plan-review.md`)   |
| 4    | Plan Finalization         | Updated plan + issues                        |
| 5    | Implementation            | Closed sub-issues, committed code            |
| 6    | Codex Code Review         | Review artifact (`*-codex-code-review.md`)   |
| 7    | Code Review Triage        | Fixes committed                              |
| 8    | Validation Gate           | Validation report (`*-validation-report.md`) |
| 9    | Human Testing + PR        | Pull request (draft, against `test`)         |
| 10   | Knowledge Persistence     | Memory doc + wiki sync                       |


**Process discipline:** Always follow all 10 steps even on "small" work. The cost of a Codex review or validation gate is fixed (~30 min); the cost of catching the same bug in production is hours. Never skip steps — if a step seems redundant, ask rather than skipping.

---

### Database — Schema Verification

Before writing any SQL or migration, query `information_schema` for exact column names on every table you'll touch. Verify first, then draft SQL — avoid naming errors (`company_name` vs `name`, `is_system_admin` vs `is_super_admin`, assumed `updated_at` columns).

---

### Database — RLS Policies

- Always enable RLS on new tables (`ALTER TABLE x ENABLE ROW LEVEL SECURITY`)
- Always specify `TO authenticated` or `TO anon`
- Use `(select auth.uid())` not `auth.uid()` directly (performance)
- Add indexes on columns used in policy conditions
- Never skip RLS on new tenant-scoped tables — tenant isolation is enforced through RLS, not application-layer filters

---

### PR Body Workflow

- **Always write the PR body to a markdown file first** at `docs/superpowers/plans/YYYY-MM-DD-<slug>-pr-body.md`
- **Use `gh pr create --body-file <path>`** — never copy/paste from chat (formatting gets stripped)
- **Always set `--base test` explicitly** — never rely on the default, which can pick `main`
