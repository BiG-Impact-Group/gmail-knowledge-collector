# CLAUDE.md — Gmail Knowledge Collector

> Read this file and `docs/project-brief.md` at the start of every session before doing anything. This is the project's working context document. `README.md` is the architectural contract. `docs/dev-rules.md` is the process authority.

## Current version

0.1.0

## Project identity

**Repo:** `gmail-knowledge-collector` (Google path only)  
**Org:** BiG-Impact-Group  
**Integration branch:** `test` — all feature PRs target this  
**Release branch:** `main` — never push directly  
**Dev server:** `http://localhost:5173` (Vite default)

## Architecture invariants

These are hard constraints. Do not work around them. If a task seems to require violating one, stop and ask.

1. **Service layer is the only browser path to Supabase.** `component → hook → service → client`. Components and hooks never import `@supabase/supabase-js` directly.

2. **OAuth tokens are server-side only.** Refresh and access tokens live in Supabase Vault or a table with no `authenticated` RLS SELECT policy. They are never returned to the browser, never logged, never committed.

3. **The browser is read-only on `messages`.** No INSERT, UPDATE, or DELETE RLS policies for `authenticated` on that table. Only the collector edge function writes, via service role.

4. **RLS on every table.** Policies scoped `TO authenticated` with `(select auth.uid())` (cached form — never bare `auth.uid()`). Separate policy per operation. Index every column in a policy condition.

5. **All migrations idempotent.** Every DDL uses `IF NOT EXISTS` / `IF EXISTS`. Never edit an applied migration — create a new one.

6. **Type generation is paired with migrations.** After every `npx supabase db push --linked`, run `npm run gen:types` and commit the updated `src/types/database.types.ts` alongside the migration file.

7. **Secrets never enter git.** `.gitignore` excludes `.env`, `.env.*`, `.claude/settings.local.json`. Edge function secrets come from Supabase Vault via `Deno.env.get()` only.

8. **Collected email is PII — never send externally.** Do not pass email content to any third-party API or external model.

9. **Email body content is untrusted.** Any future path that feeds email body to an LLM or agent requires prompt injection shielding first. Note this; do not build it this week.

## Stack quick reference

| Concern | Tool |
|---|---|
| Frontend | Vite + React 18 + TypeScript strict |
| Routing | React Router v6 |
| Server state | @tanstack/react-query |
| Forms | React Hook Form + Zod via zodResolver |
| Styles | SCSS + design tokens (no Tailwind) |
| Backend | Supabase (Postgres + Auth + RLS + Edge Functions) |
| Lint | ESLint + Stylelint |
| Tests | Jest + React Testing Library |
| Path alias | `@/` → `src/` |

## Key commands

```bash
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # TypeScript + Vite production build
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint + Stylelint
npm test             # Jest
npm run gen:types    # Regenerate database.types.ts from Supabase schema
npx supabase migration list --linked   # Migration deploy gate check
npx supabase functions deploy <name>   # Deploy an edge function
```

## Directory structure

```
src/
  components/       # React components — never import Supabase client here
  hooks/            # React Query hooks — call services only
  services/         # Only layer that imports Supabase client
  types/            # TypeScript types; database.types.ts is auto-generated
  lib/              # Supabase client singleton, utilities
supabase/
  functions/        # Edge functions (google-oauth-callback, gmail-collector)
  migrations/       # Append-only SQL migration files
docs/
  project-brief.md  # Project authority — read every session
  dev-rules.md      # 10-step epic workflow — process authority
  dev-rules-local-overrides.md  # Skill reconciliation log
  superpowers/
    plans/          # Spec and review artifacts per epic
    handoffs/       # Planner → builder handoff docs
    templates/      # Reusable templates
    memory/         # Committed epic memory docs
```

## Epic workflow gates (summary)

See `docs/dev-rules.md` for exact commands. Never skip a gate.

| Gate | Condition to pass |
|---|---|
| 1. Plan | Spec approved and committed, GitHub issues exist |
| 2. Plan review | Zero open CRITICAL Codex findings |
| 3. Build | All issues implemented, app runs, migrations in Remote column |
| 4. Code audit | Zero open CRITICAL Codex findings |
| 5. Fix | Criticals and importants resolved, audit clean |
| 6. Validate | TypeScript, lint, tests, migration check all pass |
| 7. Ship | Browser smoke test passed, draft PR opened against `test` |

## Skill changes from todo-sample baseline

See `docs/dev-rules-local-overrides.md` for full log. Summary:
- Merge base: `dev` → `test` (codex-code-review, pr-package, memory-persist)
- Codex invocation: `codex --quiet` → `codex exec -m o3 -s read-only`
- Review context: replaced momentum/insurance/SHAPE content with this project
- Validation-gate: updated Supabase project ref
- Version source: `FormStructureTree.tsx` → `package.json`
- Memory path: `momentum/memory/` → `docs/superpowers/memory/`
- `memory-persist`: wiki-sync step removed
- `design-guardian`: removed (SHAPE/SecondSight specific)

## Feature memory

| Doc | Feature | Key areas |
|---|---|---|
| (none yet — first epic in progress) | | |
