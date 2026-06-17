# Gmail Knowledge Collector (Google Path)

> Architectural contract for this repository. Read this and `CLAUDE.md` at the start of every session. Where this document and `dev-rules.md` overlap, follow `dev-rules.md` for process and this file for project decisions.

## 1. Mission

The AI pod at Big Impact Group is building a reusable platform that captures institutional knowledge of public sector workers by collecting their work data, starting with email. This repository is the **Google path** of that platform. A separate repository handles the Microsoft 365 path.

Long-term vision (architecture must anticipate but not build now): a multi-source platform connecting Gmail, Google Drive, Slack, calendars, and network drives per user — collecting, storing, then feeding a vector store for search and AI reasoning. This week: **collection and storage of Gmail only**.

## 2. Week-one definition of done

1. A user signs in to the app via Supabase Auth.
2. The user connects one or more Google accounts, granting Gmail read access through an OAuth consent screen. The architecture supports unlimited connected accounts per user.
3. A scheduled background job collects email from every connected account and stores it.
4. A two-pane view: subjects with snippets on the left, full selected email (including HTML) on the right.
5. Deployed to Netlify. Google app kept in Testing publishing status. Demonstrable end-to-end.

## 3. Stack and conventions

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18 + TypeScript strict |
| Routing | React Router v6 |
| Server state | @tanstack/react-query — no Redux, Zustand, or MobX |
| Forms | React Hook Form + Zod via zodResolver |
| Styles | SCSS with design tokens — no Tailwind; Stylelint gate enforced |
| Backend | Supabase (PostgreSQL + Auth + RLS + Edge Functions) |
| Lint | ESLint + Stylelint |
| Tests | Jest + React Testing Library |
| Path alias | `@/` → `src/` |

**Service layer rule:** `component → hook → service → Supabase client`. Components and hooks never import the Supabase client directly. Edge functions are server-side, use the service role, and are outside this rule.

**Edge functions:** Follow the momentum edge function pattern. This project uses them for the OAuth callback (`google-oauth-callback`) and the email collector (`gmail-collector`).

**RLS:** Enable on every table. Policies scoped `TO authenticated` with `(select auth.uid())` (never bare `auth.uid()` — performance). Separate policy per operation. Index columns used in policy conditions.

**Migrations:** Append-only, cloud-only, idempotent (`IF NOT EXISTS` / `IF EXISTS` everywhere). Commit paired TypeScript type generation alongside every migration.

**Validation:** Zod schemas are the single source of truth. No duplicate validation logic.

## 4. Data model

### `connected_accounts`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | FK → auth.users ON DELETE CASCADE |
| provider | text | `'google'` |
| email_address | text | The Gmail address |
| status | text | CHECK: `'active' \| 'error' \| 'revoked'` |
| granted_scopes | text | Space-separated OAuth scopes |
| sync_cursor | text | Gmail historyId or last message ID |
| last_synced_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| | UNIQUE | `(user_id, email_address)` |

RLS: authenticated users can SELECT their own rows. No browser INSERT/UPDATE/DELETE.

### `messages`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| connected_account_id | uuid | FK → connected_accounts ON DELETE CASCADE |
| user_id | uuid | Denormalized for cached RLS subselect |
| gmail_message_id | text | |
| thread_id | text | |
| from_address | text | |
| to_addresses | text | |
| subject | text | |
| snippet | text | |
| internal_date | timestamptz | |
| body_text | text | |
| body_html | text | |
| label_ids | text[] | |
| fetched_at | timestamptz | |
| | UNIQUE | `(connected_account_id, gmail_message_id)` |
| | INDEX | `(user_id, connected_account_id, internal_date DESC)` |

RLS: authenticated users can SELECT their own rows only. No browser writes. The collector edge function writes via service role.

### Token storage

OAuth refresh tokens are stored in Supabase Vault (or a service-role-only table with no authenticated RLS SELECT policy). They are never returned to the browser, never logged, never committed to git.

## 5. Architecture

### OAuth flow

```
Browser                    Edge Function                    Google OAuth
   |                            |                               |
   |-- GET /connect-google ---→ |                               |
   |                            |-- build state (HMAC-signed) →|
   |← redirect to Google ------||                               |
   |                            |                               |
   |-- user grants consent ----→→→→→→→→→→→→→→→→→→→→→→→→→→→→→|
   |                            |← code + state ---------------||
   |                            |-- validate state             |
   |                            |-- exchange code for tokens --→|
   |                            |← refresh + access tokens ----||
   |                            |-- store refresh token in Vault
   |                            |-- store connected_account record
   |← redirect to /accounts ---||
```

The OAuth redirect URI is a **deployed** Supabase Edge Function: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/google-oauth-callback`. Authorized JavaScript origins: `http://localhost:5173` and the Netlify production URL. Google allows no wildcard subdomains — Netlify preview URLs will not work for OAuth.

### Collector flow

```
Supabase Cron (pg_cron + pg_net)
   |
   |-- HTTP POST every N minutes → gmail-collector edge function
                                        |
                                        |-- read connected accounts (service role)
                                        |-- for each account:
                                        |     fetch refresh token from Vault
                                        |     exchange for access token
                                        |     fetch new messages (incremental, historyId cursor)
                                        |     decode base64url body parts
                                        |     upsert into messages (service role)
                                        |     update sync_cursor + last_synced_at
```

Cron invocation keys are read from Supabase Vault — never inline in SQL.

## 6. Google OAuth notes

- Scope: `gmail.readonly` only. No send or modify scopes.
- Publishing status: Testing. Add team demo accounts as test users.
- Production reality (document, do not build): `gmail.readonly` is a restricted scope requiring annual CASA security assessment for external users. Realistic production path for Workspace clients is a domain-wide internal install, which avoids consumer verification.

## 7. Scope

**In scope:** Supabase Auth login, connect Google account OAuth flow, scheduled collector, two-pane email viewer, Netlify deployment.

**Out of scope (future work):** Google Drive, Slack, Calendar, any non-email source, vector store/search/chat, any send/write/modify scope, production verification for external users, realtime subscriptions (React Query polling is sufficient).

## 8. Deployment

- Frontend: Netlify (Vite build, `dist/` output)
- Backend: Supabase (hosted PostgreSQL + Edge Functions)
- Edge Functions deployed with `supabase functions deploy`
- Integration branch: `test`. Release branch: `main`. Feature PRs target `test`.

## 9. Mandatory safety rules

These rules are non-negotiable. Both Codex reviews explicitly check them.

**Rule 1 — Tokens are server-side only.**
OAuth refresh and access tokens are stored encrypted in Supabase Vault or a table with no `authenticated` RLS SELECT policy. They are never returned to the browser, never selectable through any service, never logged, and never committed to git. Only edge functions under the service role may read them.

**Rule 2 — The browser is read-only on collected mail.**
There are no INSERT, UPDATE, or DELETE RLS policies for `authenticated` on the `messages` table. The collector edge function writes via the service role only.

**Rule 3 — Collected email is sensitive PII.**
This week is collection and storage only. Email content must not be sent to any third-party service or external AI model. Keep it inside Supabase.

**Rule 4 — Secrets never enter git.**
`.gitignore` excludes `.env`, `.env.*`, and `.claude/settings.local.json`. Edge function secrets are stored in Supabase Vault and accessed via `Deno.env.get()` — never hardcoded.

**Rule 5 — Collected content is untrusted input.**
Before any future step feeds collected email to a tool-calling agent or LLM, prompt injection shielding is required. This is out of scope this week, but the architecture must not assume email body content is safe.

## 10. Development workflow

Follow `docs/dev-rules.md` exactly — all 10 steps, every gate, every epic. See `docs/dev-rules-local-overrides.md` for changes made to the inherited skill set.

Key commands:
```bash
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # TypeScript + Vite production build
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint + Stylelint
npm test             # Jest
npx supabase migration list --linked   # Verify migration deploy gate
```
