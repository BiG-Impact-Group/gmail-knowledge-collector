# Project Brief: BIG Gmail Knowledge Collector (Google path)

> Durable source of truth for this build. Save this file in the repo as `docs/project-brief.md`. Every new Claude Code session, planner or builder, reads this and `CLAUDE.md` before doing anything. `dev-rules.md` is the process authority. This brief is the project authority. Where they overlap, follow `dev-rules.md` for process and this brief for project decisions.

## Mission

The AI pod at Big Impact Group is building a reusable platform that captures the institutional knowledge of public sector workers by collecting their work data from the tools they use. This repo is the Google path of the email collector. A teammate builds the Microsoft 365 equivalent in a separate repo. Build the collection capability generic and reusable, not a one-off.

Long term vision to anticipate in architecture but not build now: connect many data sources per user, Gmail first, then Google Drive, Slack, calendars, and network drives, collect and store the data, and later feed a vector store for search and reasoning.

## Week-one definition of done

1. A user signs in to the app.
2. The user connects one or more Google accounts by granting Gmail read access through an OAuth consent screen. The architecture supports an unlimited number of connected accounts per user.
3. A scheduled background job collects email from every connected account and stores it.
4. A two pane view: subjects with snippets on the left, the full selected email including HTML on the right.
5. Deployed to Netlify, the Google app kept in Testing publishing status, demonstrable end to end.

## Scope

In scope: app login via Supabase Auth, the connect Google account OAuth flow with server side token exchange in an edge function, the scheduled collector, the two pane viewer, Netlify deployment.

Out of scope this week, note as future work, do not build: Drive, Slack, calendar, any non email source, vector store or search or chat over the data, any send or write or modify scope, production verification for external users, and realtime subscriptions since React Query polling is enough.

## Stack and conventions

Full contract lives in `README.md` and `CLAUDE.md`. Summary: Vite, React 18, TypeScript strict, React Router v6, React Query for server state with no Redux or Zustand or MobX, React Hook Form with Zod via zodResolver, SCSS design tokens with no Tailwind under the Stylelint gate, Supabase for Postgres and Auth and RLS and Edge Functions, ESLint and Stylelint, Jest with React Testing Library. The service layer is the only browser path to Supabase: component to hook to service to client. Edge functions are server side, use the service role, and are separate from that rule. RLS is the authorization layer with separate per operation policies scoped `TO authenticated` and the cached `(select auth.uid())` subselect. Migrations are append only, cloud only, idempotent, with paired type generation committed alongside. Validation lives in Zod schemas as the single source of truth. Use the `@/` path alias.

Our todo-sample omits Edge Functions, but momentum uses them under `supabase/functions/`. This project needs them for the OAuth callback and the collector, so follow the momentum edge function pattern for those.

## Architecture intent (input to brainstorm, not final)

- App login is Supabase Auth. Connecting a Gmail account is a separate OAuth 2.0 authorization code flow whose redirect target is a deployed Supabase Edge Function that validates a signed state parameter, exchanges the code, and stores the refresh token server side linked to the app user. One app user can link many inboxes.
- Collector: a Supabase Edge Function invoked on a schedule by Supabase Cron (pg_cron with pg_net). It iterates connected accounts, refreshes access tokens, fetches new mail incrementally using a per account cursor, decodes the base64url body parts, and stores under the service role. A few minute interval, not 60 seconds. Cron reads its keys from Supabase Vault, never inline.
- Data model in our table and RLS style, refine in brainstorm:
  - `connected_accounts`: id, user_id referencing auth.users on delete cascade, provider, email_address, status with a CHECK, granted_scopes, sync_cursor, last_synced_at, timestamps, unique on user_id and email_address.
  - `messages`: id, connected_account_id on delete cascade, user_id denormalized for the cached RLS subselect, gmail_message_id, thread_id, from, to, subject, snippet, internal_date, body_text, body_html, label_ids, fetched_at, unique on connected_account_id and gmail_message_id, indexed on user_id and connected_account_id and internal_date.
  - RLS: authenticated users get SELECT only on their own rows in both tables. The browser never writes messages. The collector writes under the service role.

## Google OAuth and Gmail

- Request only the `gmail.readonly` scope. No send or modify scopes.
- Keep the OAuth app in Testing publishing status for the demo and add team accounts as test users. Testing status permits a limited set of test users with no security assessment.
- Production reality, document but do not build: `gmail.readonly` is a Google restricted scope. Serving external users in production requires an annual third party security assessment (CASA), which is costly and slow. The realistic production path for public sector clients on Google Workspace is an internal or domain wide install inside the client's own Workspace, which avoids the consumer verification wall.
- Redirect URI to register, the deployed edge function callback: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/google-oauth-callback`. Authorized JavaScript origins: `http://localhost:5173` and the Netlify production URL. Google allows no wildcard subdomains, so Netlify random preview URLs will not work for OAuth. Create the client ID and secret only after the exact redirect URI is set.

## Supabase Cron

Use Supabase Cron (pg_cron with pg_net) to invoke the collector edge function on a schedule. Read the invocation keys from Supabase Vault, never inline. Keep concurrent jobs low and each run short. One collector job on a few minute interval.

## Mandatory safety rules

Beyond the generic guardrails, which were written for an app with no secrets. Put these in `README.md` and `CLAUDE.md`, bake them into the spec during brainstorm, and have both Codex reviews check them explicitly.

1. Tokens are server side only. OAuth refresh and access tokens are stored encrypted in Supabase Vault or in a table that no `authenticated` RLS policy can read. Never returned to the browser, never selectable through any service, never logged, never committed. Only edge functions under the service role read them.
2. The browser is read only on collected mail. No INSERT, UPDATE, or DELETE policies for `authenticated` on `messages`. The collector writes under the service role.
3. Collected email is sensitive PII. This week is collection and storage only. Do not send email content to any third party or any external model. Keep it inside Supabase.
4. Secrets never enter git. `.gitignore` excludes `.env`, `.env.*`, and `.claude/settings.local.json`. Never stage them.
5. Collected content is untrusted input for any future reasoning feature. Before any later step feeds this mail to a tool calling agent, prompt injection shielding is required. Out of scope this week, but the architecture must not assume the content is safe.

## Phase 0 reconciliation checklist

The inherited skills come from the momentum project and an older toolchain. Apply all of these before any planning, and log every change in `docs/dev-rules-local-overrides.md`.

1. Base branch. Change the diff base from `dev` to `test` in `codex-code-review`, `pr-package`, and `memory-persist`. The repo standardizes on `test`.
2. Codex invocation. In `codex-plan-review` and `codex-code-review`, replace `codex ... --quiet "<prompt>"` with `codex exec`, piping the prompt file in. Confirm flags via `codex --help` and `codex exec --help`. Replace the hardcoded model `gpt-5.4-high` with a model the installed Codex offers. Keep reviews in the default read-only sandbox.
3. Codex review context. Replace the momentum domain in both Codex prompt templates (insurance SaaS, multi-tenant, tenant_id, llmService, variable_registry, Scandinavian Minimalism) with this project: React 18 plus TypeScript plus Vite plus Supabase Gmail collector, per-user RLS not multi-tenant, SCSS tokens. Add the safety rules above to both review prompts.
4. Validation gate project ref. Replace momentum's Supabase project ref in `validation-gate` with this project's ref so the migration gate validates against our project.
5. Version source. Point `feature-commit` versioning at this repo's `package.json` instead of the momentum component file.
6. Memory path. Point `feature-commit` and `memory-persist` at `docs/superpowers/memory/` instead of `momentum/memory/`, so epic memory docs are committed with the repo.
7. Wiki sync. Remove the `/wiki-sync` step from `memory-persist`. The committed memory doc is the artifact.
8. design-guardian. Remove it from `.claude/skills/`. It is SHAPE and SecondSight specific and references assets we do not have. UI quality relies on Stylelint plus `react-best-practices` and `composition-patterns`.
9. supabase-mcp. Opaque packaged skill. At first use, confirm it targets our linked project, not a momentum one. Stop if it targets a different project.
10. Documentation only, record but no behavior change: the Windows path and dev port 8081 in `dev-rules.md` (our Vite default is 5173), and the momentum directory names in the `spawn-planner` untracked-shared check.

## Workflow gate contract

Follow `dev-rules.md` for exact commands and artifacts. Announce each gate, never skip one, ask rather than skip if a step seems redundant.

1. Plan. `/spawn-planner <slug>`, then `/brainstorm`, then decompose into GitHub issues. Gate: spec approved and committed, issues exist.
2. Review the plan. `/codex-plan-review`, apply accepted findings, re-run until zero criticals. Gate: zero open criticals.
3. Build. `/spawn-builder epic-NN-<slug>`, implement with tests, keep the planner worktree alive, apply migrations so each appears in the Remote column of `npx supabase migration list --linked`. Gate: issues done, app runs, migrations applied.
4. Audit the code. `/codex-code-review` on the full diff. Gate: zero open criticals.
5. Fix. Triage and fix criticals and importants, commit, re-run the audit if substantial. Gate: audit clean.
6. Validate. `/validation-gate`: build, lint, unit tests, migration check. Gate: zero failures.
7. Human test and ship. Browser smoke test, then `/pr-package` opens a draft PR against `test`, never `main`. After merge, `/memory-persist`.

Hard rules across all of it: never write application code before the plan is approved, never push directly to `main` or `test`, never open a PR with unapplied migrations or open criticals, never commit secrets.

## Demo target (week one)

A deployed Netlify URL, a seeded test account with at least one connected Gmail account that has collected mail visible in the two pane view, and a short run sheet that walks sign in, connect account, wait for the collector, and view email. Keep the Google app in Testing status with the demo accounts added as test users.

## Decisions log

- Repo: one repo for the Google path, the manual process journal lives inside it. Microsoft 365 is a separate repo, not our concern.
- Repo name and folder: `gmail-knowledge-collector`, kebab-case, matching the worktree path basename.
- Integration branch: `test`. Release branch: `main`. Feature work on `feature/epic-NN-<slug>`, planning on `plan/<slug>`, both via the spawn skills.
- OAuth callback: a deployed Supabase Edge Function, chosen to match cloud-only Supabase and to give one stable redirect URI.
- Build method: Claude Code with Codex review owns the entire build, planning through delivery, using the inherited system. No external assistant in the loop.

## Operating model and session continuity

This build runs entirely inside Claude Code. The durable context is this brief plus `README.md`, `CLAUDE.md`, and `docs/dev-rules-local-overrides.md`, all committed to the repo. His workflow starts a fresh session per worktree, so every new session begins by reading `CLAUDE.md` and this brief. The human acts only at the gates: spec approval, the accept or reject calls on both Codex reviews, and the browser smoke test.
