# Claude Code Kickoff — Scope B

This is the prompt to start each epic in Claude Code. The goal of each kickoff is to finish the comprehensive spec for that epic with Claude Code in a brainstorm session, using the handoff seed as the starting point. It assumes `docs/scope-b-brainstorm-handoff.md` is committed.

Run the epics in order: 03, 04, 05, 06, 07. Each is one PR against `test`.

---

## One-time, before the first epic

Confirm Phase 0 reconciliation, since the program relies on the Codex gates.

1. In `.claude/skills/codex-plan-review` and `.claude/skills/codex-code-review`, confirm they invoke `codex exec` with the prompt piped from a file and name a model the installed Codex offers. Fix and log in `docs/dev-rules-local-overrides.md` if not.
2. Confirm both Codex prompt templates describe this project (React, TypeScript, Vite, Supabase, per-user RLS, SCSS tokens, the brief's safety rules), not the momentum insurance-SaaS domain. Fix and log if not.
3. Confirm `supabase/.temp/project-ref` reads `ybgtzyutbvwfhgtlmnah`. Already correct as of 2026-06-25.

---

## Per-epic kickoff

Replace `<NN>` and `<slug>`, for example `03` and `oauth-lifecycle`. Start a fresh terminal and a fresh Claude Code session.

### Step 0 — Sync and read

```bash
pwd
git checkout test
git pull origin test
git status
```

First message to the session:

> Read `CLAUDE.md`, `docs/project-brief.md`, `docs/dev-rules.md`, `docs/dev-rules-local-overrides.md`, and `docs/scope-b-brainstorm-handoff.md`. `dev-rules.md` is the process authority, `project-brief.md` is the project authority, and the handoff is the seed for this phase. We are going to finish the spec for Epic <NN> (<slug>) together. Read the Epic <NN> seed in the handoff: its goal, the repo grounding, and the open questions. Confirm you have read everything and summarize the Epic <NN> scope and its open questions back to me in a few lines. Do not write application code before the plan is approved and committed.

### Step 1 to 4 — Brainstorm the spec, then review it

```bash
/spawn-planner <slug>
```

Open the printed terminal, launch the planner session there, then:

> Run `/brainstorm` for Epic <NN>. Use the Epic <NN> seed in `docs/scope-b-brainstorm-handoff.md` as the starting point. The decisions in that handoff are settled, do not reopen them. Drive the session by resolving the open questions listed for this epic, asking me one at a time, then expand the seed into the full design: data model, RLS policies, edge functions, frontend, tests, acceptance criteria, deployment order, and rollback. Write the finalized spec to `docs/superpowers/plans/2026-06-<dd>-<slug>-design.md` and commit it.

Then decompose into a GitHub epic issue and sub-issues, and run `/codex-plan-review`, iterating until zero criticals and committing each round.

### Step 4.5 — Hand off to a builder worktree

```bash
git push -u origin plan/<slug>
/spawn-builder epic-<NN>-<slug>
```

Open the printed terminal, launch the builder, keep the planner worktree alive for plan revisions.

### Step 5 to 8 — Build, review, validate

> Implement the closed sub-issues. For every migration: create with `npx supabase migration new`, apply with `npx supabase db push --linked`, confirm it shows in the Remote column of `npx supabase migration list --linked`, run `npm run gen:types`, and commit the migration and `database.types.ts` together. Commit with `git add <specific-files>`, never `git add -A`.

```
/codex-code-review
```

Iterate to zero criticals, fix criticals and importants, then `/validation-gate`.

### Step 9 to 10 — Human test and ship

Smoke test against the Netlify preview the PR creates, then `/pr-package` to open a draft PR against `test`, never `main`. After merge, `/memory-persist` and delete the local feature branch.

---

## The overnight model

The handoff and the brainstorm output are what let the build run with minimal supervision. After the spec is finalized and decomposed, use plan mode and auto-approve and kick off the builder before a break or overnight. You act at four points per epic: approve the spec, accept or reject each Codex review, and run the browser smoke test.

---

## Epic order and dependencies

1. Epic 03 oauth-lifecycle. No dependency. Includes the provider-aware unique key Epic 04 needs.
2. Epic 04 drive-collector. Needs 03 merged.
3. Epic 05 file-processing-pipeline. Needs 04.
4. Epic 06 vector-store. Needs 05, and the embedding model and dimension confirmed first.
5. Epic 07 basic-rag. Needs 06.

Do not start Epic 04 until Epic 03 is merged to `test`, because the unique-key change must be in place before Drive OAuth can attach a second connection to the same Google account.
