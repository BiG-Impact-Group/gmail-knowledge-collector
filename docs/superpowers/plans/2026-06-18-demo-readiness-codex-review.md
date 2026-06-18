Reading additional input from stdin...
OpenAI Codex v0.141.0
--------
workdir: /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: none
reasoning summaries: none
session id: 019edbcd-7691-7401-afd4-e20f7f6ca23a
--------
user
Perform an adversarial plan review using the criteria and context in the prompt below. Be specific — cite exact work units, tables, and files. You are an adversarial plan reviewer for a software project. Your job is to find
problems, gaps, and risks that the planning team may have missed. Be specific and
constructive — vague concerns are useless.

## Project context

This is a Gmail Knowledge Collector: React 18 + TypeScript + Vite frontend, Supabase
backend (PostgreSQL + RLS + Edge Functions). It collects Gmail via OAuth 2.0 and stores
email for public sector knowledge capture. Per-user row isolation (not multi-tenant
org isolation) via RLS. SCSS design tokens, no Tailwind. Edge Functions handle OAuth
token exchange and scheduled email collection. The browser is read-only on collected mail.

Key constraints:
- RLS on all tables; policies scoped TO authenticated with (select auth.uid())
- OAuth refresh tokens stored server-side only (Supabase Vault or service-role-only table)
- Tokens NEVER returned to browser, never logged, never committed to git
- Browser has no INSERT/UPDATE/DELETE on messages — only edge functions write via service role
- Collected email is PII — never sent to third-party services or external models
- Secrets never enter git (.env excluded; use Supabase Vault for edge function secrets)
- All migrations idempotent (IF NOT EXISTS / IF EXISTS everywhere)
- Paired type generation committed alongside every migration

## Your review criteria

Evaluate the plan against these dimensions:

1. **Completeness** — Are there missing work units? Gaps between what the plan promises and what the units deliver?
2. **Dependency ordering** — Are the units in the right build order? Would any unit fail because a prerequisite isn't ready?
3. **Test coverage** — Are the defined tests sufficient? Missing edge cases? Missing negative tests?
4. **Security / token safety** — Tokens server-side only? No path that could leak refresh/access tokens to the browser? RLS gaps? Auth gaps?
5. **Database design** — Schema issues? Missing indexes? Non-idempotent migrations? Missing type generation step?
6. **Integration risk** — Which parts are most likely to break existing functionality? What's the riskiest unit?
7. **Performance** — Any N+1 queries? Unbounded fetches? Missing pagination? Heavy client-side computation?
8. **Rollback strategy** — If this fails in production, how do we back it out? Is that addressed?
9. **Safety rules compliance** — Does the plan explicitly address all five mandatory safety rules (token isolation, read-only browser, PII containment, secrets out of git, untrusted content note)?

## Output format

For each finding, provide:
- **Category**: (completeness | ordering | testing | security | database | integration | performance | rollback | safety)
- **Severity**: (critical | important | suggestion)
- **Finding**: What's wrong or missing (be specific — name files, tables, work units)
- **Recommendation**: What to do about it

End with a summary: overall plan quality (1-10), top 3 risks, and whether the plan is ready for implementation or needs revision.

---

## Plan under review

# Epic Spec: Demo-Readiness
**Slug:** demo-readiness  
**Branch:** plan/demo-readiness → feature/demo-readiness  
**Date:** 2026-06-18  
**Author:** Planner agent  
**Status:** Draft — awaiting approval

---

## Context

The Gmail Knowledge Collector MVP (Epics 01 + 02) is merged to `main`. The next show-and-tell is Wednesday or Thursday 2026-06-25. This epic closes the gaps identified in the Phase A audit before that demo.

Source of truth: Tuesday 2026-06-16 meeting transcript (Terrence Kunstek, Caleb Crane, Cloee Kunstek) and the Phase A gap report.

---

## Approved scope

### EU-14 — Paginated 12-month backfill

**Why:** The current collector fetches 200 messages on first sync and stops. The use case (Town of Fishers snow plow workers retiring) requires career-spanning email — 200 messages is insufficient. 12 months is the agreed starting depth; widening it later requires only clearing `sync_cursor` and `backfill_complete`.

**What:**
- Add `backfill_complete boolean NOT NULL DEFAULT false` and `backfill_page_token text` columns to `connected_accounts` (idempotent migration).
- Collector logic:
  - If `backfill_complete = false`: call `messages.list` with `maxResults=200` and a date cutoff of `after:YYYY/MM/DD` (12 months ago). Follow `nextPageToken` across cron runs using `backfill_page_token`. On the final page (no `nextPageToken`), set `backfill_complete = true`, clear `backfill_page_token`, and set `sync_cursor` from `users/me/profile`.
  - If `backfill_complete = true`: use the existing History API incremental path (unchanged).
- Rate: 200 messages per cron run during backfill (same as current). A typical 12-month inbox of ~2,400 messages completes in 12 runs (~1 hour at 5-min cron).
- Existing accounts with `sync_cursor` set but `backfill_complete = false` (the default after migration) will re-enter the backfill path on next run. This is intentional — the cursor they have was set on a 200-message partial sync.

**Migrations:**
- `20260618000001_backfill_columns.sql` — adds `backfill_complete`, `backfill_page_token` with `IF NOT EXISTS`.

**Tests:** Unit test for the backfill branch of the collector logic (mock `nextPageToken` present / absent).

**Out of scope:** Progress UI, rate-limit backoff (noted as future work).

---

### EU-15 — Account attribution in email viewer

**Why:** Connecting multiple accounts is invisible in the current viewer — all emails look identical regardless of source inbox. Terrence stated at 00:30:10 that one user must be able to connect an infinite number of accounts. Without attribution, the multi-inbox capability cannot be demonstrated.

**What:**
- Add an account label (email address) to each row in the `MessageItem` component. Position: small muted badge below the sender name.
- Add an account filter dropdown/selector in the `EmailPage` list pane header. Options: "All accounts" + one entry per connected account. Selecting an account filters the list.
- `getMessages()` in `messages.service.ts` accepts an optional `connectedAccountId` filter parameter; when provided, adds `.eq('connected_account_id', id)` to the query.
- `useMessages` hook passes the filter through from `EmailPage` state.
- No new RLS or migrations required — `connected_account_id` already exists on `messages`.

**Tests:** Update `messages.service.test.ts` to cover the filtered path. Update `EmailPage` test for filter state.

---

### EU-16 — Generic connector seam

**Why:** Terrence was emphatic at 00:13:59: *"this capability I want you guys to build it in a generic fashion so that when we use the same capability on project after project... we don't have to rebuild it from scratch."* The files collector and Slack collector are week-2 and week-3 targets.

**What (light refactor — no new features):**
- Define a `Provider` type: `'google' | 'microsoft' | 'slack'` in `src/types/provider.ts`.
- Rename `initiateGoogleOAuth` → `initiateOAuth(provider: Provider)` in `accounts.service.ts`. For now the only implemented path is `'google'`; other values throw `'not implemented'`. Update all call sites.
- Rename edge functions conceptually in code comments only — do not rename the deployed functions (would break existing OAuth redirect URIs). Add a `// CONNECTOR SEAM:` comment block at the top of `google-oauth-initiate`, `google-oauth-callback`, and `gmail-collector` explaining what a second connector would need to implement.
- Add `src/types/connector.ts` with a `ConnectorConfig` interface documenting the shape a connector must provide (initiateUrl, callbackPath, scopes, provider).
- Update README section 7 (Scope) to document the connector seam and list Google as the implemented connector.

**No migrations. No new edge functions. No behavior change.**

---

### EU-17 — Manual process journal

**Why:** Terrence explicitly assigned this at 00:22:47: *"Write up document anything you manually do... keep a little bit of a journal... separate markdown file... you had to do screenshots."* Rationale: Google Console and Supabase dashboards change frequently; the journal captures the exact steps taken so the next person isn't starting from scratch.

**What:**
- Create `docs/manual-process-journal.md`.
- Document every manual step taken during this project to date:
  - Google Cloud Console: project creation, OAuth client, authorized origins and redirect URIs, test users, scopes
  - Supabase: project creation, Auth → Google provider setup, Site URL + Redirect URLs, Vault secret creation, edge function secrets, cron job setup
  - Netlify: site creation, environment variables, deploy branch configuration
- Each entry: date, platform, what was done, why, any gotchas. Screenshots are encouraged but not required (describe what to look for).

---

### EU-18 — Git pre-commit hook

**Why:** Terrence named this at 00:29:10 and 00:30:10: *"if you guys can put git hooks into your application... have unit tests... to prevent regression errors."*

**What:**
- Create `.githooks/pre-commit` (shell script, executable):
  ```sh
  #!/bin/sh
  npm run lint && npm test -- --passWithNoTests
  ```
- Add to `package.json` scripts: `"prepare": "git config core.hooksPath .githooks"` so the hook is activated for any developer who runs `npm install`.
- Commit `.githooks/pre-commit` to the repo (not `.git/hooks/`, which is not tracked by git).
- Document in README under Development Workflow.

**Note:** The hook runs on every commit, so it must stay fast. Jest with `--passWithNoTests` already runs in under 2 seconds.

---

### EU-19 — Demo run sheet

**Why:** The show-and-tell is Wednesday or Thursday 2026-06-25. Terrence set the agenda at 00:29:10. A run sheet keeps the demo on track and serves as the acceptance test for this epic.

**What:**
- Create `docs/demo-runsheet.md`.
- Contents:
  1. Pre-demo checklist (confirm Netlify is live, confirm at least 2 accounts connected, confirm emails visible)
  2. Sign-in walkthrough (go to URL, click Continue with Google, land on Accounts page)
  3. Connect a second account (click Connect Gmail, grant consent, return to Accounts with 2 cards)
  4. Wait for collector (explain the 5-minute cron, refresh)
  5. View emails (navigate to Emails, show list from both accounts, click one, show HTML rendering)
  6. Talking points (12-month backfill, generic platform, future: Drive, Slack, calendar)
  7. Out-of-scope callouts (no search yet, no vector store — collect and gather only)

---

## Out of scope — do not build

Per Terrence's explicit deferral and the Phase A recommendation:

- Rate-limit (429) backoff on Gmail API — future work
- Disconnect / remove account button — future work
- Files collector (Google Drive) — week 2
- Slack / chat collector — week 3
- Vector store, embeddings, search, chat over data — future
- Meeting recorder / speaker identification — week 4 bonus
- Production prompt injection shields — production only

---

## Migration checklist

| File | Change | Idempotent? |
|---|---|---|
| `20260618000001_backfill_columns.sql` | ADD COLUMN IF NOT EXISTS `backfill_complete`, `backfill_page_token` | Yes |

---

## Issue decomposition

| Issue | Title | Epic unit |
|---|---|---|
| #1 | feat: paginated 12-month backfill in gmail-collector | EU-14 |
| #2 | feat: account attribution and filter in email viewer | EU-15 |
| #3 | refactor: generic connector seam (Provider type, initiateOAuth, ConnectorConfig) | EU-16 |
| #4 | docs: manual process journal | EU-17 |
| #5 | chore: git pre-commit hook for lint and tests | EU-18 |
| #6 | docs: demo run sheet | EU-19 |

---

## Safety rules (unchanged)

All rules from `docs/project-brief.md` and `README.md` remain in force:

1. Tokens server-side only — no change to token handling in this epic.
2. Browser read-only on `messages` — `getMessages()` filter parameter adds a SELECT condition only.
3. Email is PII — not sent to any external service.
4. Secrets never in git.
5. Email content is untrusted input — no LLM feeding in this epic.

## Project architecture (CLAUDE.md)

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
codex
I’ll check the actual repo shape before reviewing the plan so the findings can name real files, tables, and implementation risks rather than just reacting to the spec text.
exec
/bin/zsh -lc 'pwd && ls' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
/Users/caleb/Documents/Claude Code/gmail-knowledge-collector
CLAUDE.md
README.md
dist
docs
eslint.config.js
index.html
jest.config.ts
netlify.toml
node_modules
package-lock.json
package.json
src
supabase
tsconfig.json
tsconfig.node.json
vite.config.ts

exec
/bin/zsh -lc 'rg --files' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
tsconfig.node.json
index.html
netlify.toml
src/services/accounts.service.test.ts
src/services/messages.service.ts
src/services/messages.service.test.ts
src/services/accounts.service.ts
src/lib/supabase.ts
src/hooks/useMessages.ts
src/hooks/useMessage.ts
src/hooks/useAccounts.ts
src/vite-env.d.ts
src/components/email/MessageDetail.test.tsx
src/components/email/EmailPage.module.scss
src/components/email/MessageList.tsx
src/components/email/MessageList.module.scss
src/components/email/MessageItem.module.scss
src/components/email/MessageItem.tsx
src/components/email/EmailPage.test.tsx
src/components/email/EmailPage.tsx
src/components/email/MessageDetail.tsx
src/components/email/MessageDetail.module.scss
src/components/accounts/AccountCard.module.scss
src/components/accounts/AccountsPage.test.tsx
src/components/accounts/AccountCard.tsx
src/components/accounts/AccountsPage.tsx
src/components/accounts/AccountsPage.module.scss
src/components/shared/EmptyState.tsx
src/components/shared/EmptyState.module.scss
src/components/auth/LoginPage.module.scss
src/components/auth/LoginPage.test.tsx
src/components/auth/LoginPage.tsx
src/styles/global.scss
src/styles/_tokens.scss
src/test/setup.ts
src/test/App.test.tsx
src/test/__mocks__/styleMock.ts
src/types/database.types.ts
src/main.tsx
src/App.tsx
jest.config.ts
CLAUDE.md
vite.config.ts
.env.example
eslint.config.js
tsconfig.json
package.json
package-lock.json
README.md
supabase/functions/google-oauth-callback/index.ts
supabase/functions/gmail-collector/index.ts
supabase/functions/google-oauth-initiate/index.ts
supabase/migrations/20260617000001_initial_schema.sql
supabase/migrations/20260617000002_vault_helpers.sql
supabase/migrations/20260617000003_cron_collector.sql
docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md
docs/dev-rules-local-overrides.md
docs/project-brief.md
docs/dev-rules.md

exec
/bin/zsh -lc 'git status --short' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-9kQ9QpVo' (errno=Operation not permitted)
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
git: error: couldn't create cache file '/tmp/xcrun_db-EqctXJRz' (errno=Operation not permitted)

codex
The repository is small and the plan maps onto existing files directly: the collector edge function, message/account services, email UI components, migrations, and generated DB types. I’m reading those now to check whether the proposed work units actually line up with the current implementation.
exec
/bin/zsh -lc "sed -n '1,220p' src/services/accounts.service.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,220p' supabase/functions/gmail-collector/index.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type ConnectedAccount = Tables<'connected_accounts'>

export async function getAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

export async function initiateGoogleOAuth(): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ url: string }>('google-oauth-initiate')
  if (error) throw error
  if (data?.url) {
    window.location.href = data.url
  }
}

 succeeded in 0ms:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

interface GmailMessage {
  id: string
  threadId: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: GmailPart[]
    mimeType?: string
  }
  snippet?: string
  internalDate?: string
  labelIds?: string[]
}

interface GmailPart {
  mimeType: string
  body?: { data?: string }
  parts?: GmailPart[]
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function extractBody(payload: GmailMessage['payload']): { text: string | null; html: string | null } {
  if (!payload) return { text: null, html: null }

  function findParts(parts: GmailPart[] | undefined, mimeType: string): string | null {
    if (!parts) return null
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return base64urlDecode(part.body.data)
      }
      const nested = findParts(part.parts, mimeType)
      if (nested) return nested
    }
    return null
  }

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { text: base64urlDecode(payload.body.data), html: null }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return { text: null, html: base64urlDecode(payload.body.data) }
  }

  const html = findParts(payload.parts, 'text/html')
  const text = findParts(payload.parts, 'text/plain')
  return { html, text }
}

function getHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error('token_refresh_failed'), {
      tokenError: (err as Record<string, string>).error,
    })
  }
  const data = await res.json() as { access_token: string }
  return data.access_token
}

async function fetchFullMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const res = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch message ${messageId}`)
  return res.json()
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')!
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('connected_accounts')
    .select('id, user_id, email_address, sync_cursor')
    .eq('status', 'active')

  if (accountsError) {
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const account of (accounts ?? [])) {
    try {
      const { data: refreshToken } = await supabaseAdmin
        .rpc('get_vault_secret', { secret_name: account.id })

      if (!refreshToken) {
        console.error(`No vault secret for account ${account.id}`)
        errors++
        continue
      }

      let accessToken: string
      try {
        accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
      } catch (err: unknown) {
        const tokenErr = err as { tokenError?: string }
        if (tokenErr.tokenError === 'invalid_grant' || tokenErr.tokenError === 'token_revoked') {
          await supabaseAdmin
            .from('connected_accounts')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('id', account.id)
        }
        errors++
        continue
      }

      let messageIds: string[] = []
      let newCursor: string | null = null

      if (!account.sync_cursor) {
        const res = await fetch(
          `${GMAIL_API}/users/me/messages?maxResults=200`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) { errors++; continue }
        const data = await res.json() as { messages?: Array<{ id: string }> }
        messageIds = (data.messages ?? []).map(m => m.id)
        // messages.list has no historyId — fetch it from profile
        const profileRes = await fetch(
          `${GMAIL_API}/users/me/profile`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (profileRes.ok) {
          const profile = await profileRes.json() as { historyId?: string }
          newCursor = profile.historyId ?? null
        }
      } else {
        const res = await fetch(
          `${GMAIL_API}/users/me/history?startHistoryId=${account.sync_cursor}&historyTypes=messageAdded`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) {
          if (res.status === 404) {
            // Cursor too old — reset so next run does a full resync
            await supabaseAdmin
              .from('connected_accounts')
              .update({ sync_cursor: null, updated_at: new Date().toISOString() })
              .eq('id', account.id)
          }
          errors++
          continue
        }
        const data = await res.json() as {
          history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>
          historyId?: string
        }
        newCursor = data.historyId ?? account.sync_cursor
        messageIds = (data.history ?? [])
          .flatMap(h => h.messagesAdded ?? [])
          .map(m => m.message.id)
      }

      for (const msgId of messageIds) {
        try {
          const msg = await fetchFullMessage(accessToken, msgId)
          const headers = msg.payload?.headers
          const { text, html } = extractBody(msg.payload)

          await supabaseAdmin.from('messages').upsert({
            connected_account_id: account.id,
            user_id: account.user_id,
            gmail_message_id: msg.id,
            thread_id: msg.threadId ?? null,
            from_address: getHeader(headers, 'from'),
            to_addresses: getHeader(headers, 'to'),
            subject: getHeader(headers, 'subject'),
            snippet: msg.snippet ?? null,
            internal_date: msg.internalDate
              ? new Date(parseInt(msg.internalDate)).toISOString()
              : null,
            body_text: text,
            body_html: html,
            label_ids: msg.labelIds ?? null,
          }, { onConflict: 'connected_account_id,gmail_message_id', ignoreDuplicates: true })


exec
/bin/zsh -lc "sed -n '1,220p' src/services/messages.service.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/types/database.types'

export type Message = Tables<'messages'>
export type MessageListItem = Pick<Message, 'id' | 'from_address' | 'subject' | 'snippet' | 'internal_date' | 'connected_account_id'>

export async function getMessages(): Promise<MessageListItem[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, from_address, subject, snippet, internal_date, connected_account_id')
    .order('internal_date', { ascending: false })
    .range(0, 199)

  if (error) throw error
  return data
}

export async function getMessage(id: string): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    // PGRST116 = no rows returned
    if ((error as { code?: string }).code === 'PGRST116') return null
    throw error
  }
  return data
}

exec
/bin/zsh -lc "sed -n '1,260p' supabase/migrations/20260617000001_initial_schema.sql" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
-- connected_accounts: stores OAuth-connected Gmail accounts per user
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'google',
  email_address     text NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CONSTRAINT connected_accounts_status_check
                    CHECK (status IN ('active', 'error', 'revoked')),
  granted_scopes    text,
  sync_cursor       text,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connected_accounts_user_email_unique UNIQUE (user_id, email_address)
);

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'connected_accounts' AND policyname = 'users select own accounts'
  ) THEN
    CREATE POLICY "users select own accounts"
      ON connected_accounts
      FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS connected_accounts_user_id_idx
  ON connected_accounts (user_id);

CREATE INDEX IF NOT EXISTS connected_accounts_user_id_status_idx
  ON connected_accounts (user_id, status);

-- messages: collected email messages, written only by the collector edge function
CREATE TABLE IF NOT EXISTS messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id  uuid NOT NULL
                        REFERENCES connected_accounts(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  gmail_message_id      text NOT NULL,
  thread_id             text,
  from_address          text,
  to_addresses          text,
  subject               text,
  snippet               text,
  internal_date         timestamptz,
  body_text             text,
  body_html             text,
  label_ids             text[],
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_account_gmail_id_unique
    UNIQUE (connected_account_id, gmail_message_id)
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'users select own messages'
  ) THEN
    CREATE POLICY "users select own messages"
      ON messages
      FOR SELECT
      TO authenticated
      USING ((select auth.uid()) = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_user_id_internal_date_idx
  ON messages (user_id, internal_date DESC);

CREATE INDEX IF NOT EXISTS messages_user_id_account_id_internal_date_idx
  ON messages (user_id, connected_account_id, internal_date DESC);

CREATE INDEX IF NOT EXISTS messages_connected_account_id_idx
  ON messages (connected_account_id);

exec
/bin/zsh -lc "sed -n '220,520p' supabase/functions/gmail-collector/index.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,320p' supabase/functions/google-oauth-callback/index.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:

          processed++
        } catch {
          // Skip individual message failures
        }
      }

      await supabaseAdmin
        .from('connected_accounts')
        .update({
          sync_cursor: newCursor,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', account.id)

    } catch {
      errors++
    }
  }

  return Response.json({ processed, errors, accounts: accounts?.length ?? 0 })
})

 succeeded in 0ms:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

interface StatePayload {
  user_id: string
  nonce: string
  exp: number
}

async function verifyStateJwt(token: string, secret: string): Promise<StatePayload> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid state token')
  const [header, payload, signature] = parts
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const sigBytes = Uint8Array.from(
    atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  )
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(signingInput))
  if (!valid) throw new Error('Invalid signature')
  const data: StatePayload = JSON.parse(base64urlDecode(payload))
  if (data.exp < Math.floor(Date.now() / 1000)) throw new Error('State token expired')
  return data
}

function extractEmailFromIdToken(idToken: string): string {
  const payload = JSON.parse(base64urlDecode(idToken.split('.')[1]))
  return payload.email as string
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const stateSecret = Deno.env.get('STATE_SECRET')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
  const siteUrl = Deno.env.get('SITE_URL') ?? 'http://localhost:5173'

  if (errorParam || !code || !state) {
    return Response.redirect(`${siteUrl}/accounts?error=oauth_denied`, 302)
  }

  let statePayload: StatePayload
  try {
    statePayload = await verifyStateJwt(state, stateSecret)
  } catch (e) {
    console.error('State verification failed:', e)
    return new Response('Invalid or expired state. Please try again.', { status: 400 })
  }

  let tokenRes: Response
  try {
    tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
  } catch (e) {
    console.error('Token exchange fetch failed:', e)
    return new Response('Token exchange network error', { status: 502 })
  }

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({})) as { error?: string }
    console.error('Token exchange failed', { status: tokenRes.status, error: err.error })
    return new Response('Token exchange failed', { status: 502 })
  }

  const tokens = await tokenRes.json() as {
    refresh_token?: string
    access_token: string
    id_token: string
  }

  if (!tokens.refresh_token) {
    console.error('No refresh_token in response. Tokens keys:', Object.keys(tokens))
    return new Response('No refresh token returned. Revoke access at myaccount.google.com/permissions and try again.', { status: 400 })
  }

  let emailAddress: string
  try {
    emailAddress = extractEmailFromIdToken(tokens.id_token)
  } catch (e) {
    console.error('Failed to extract email from id_token:', e)
    return new Response('Failed to read account email', { status: 500 })
  }

  const userId = statePayload.user_id
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  // Save account as 'error' first; update to 'active' only after vault write succeeds
  const { data: account, error: upsertError } = await supabaseAdmin
    .from('connected_accounts')
    .upsert({
      user_id: userId,
      provider: 'google',
      email_address: emailAddress,
      status: 'error',
      granted_scopes: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,email_address',
      ignoreDuplicates: false,
    })
    .select('id')
    .single()

  if (upsertError || !account) {
    console.error('Upsert error:', JSON.stringify(upsertError))
    return new Response('Failed to save account', { status: 500 })
  }

  // Store refresh token in Vault keyed by account id
  const { data: existingSecretId, error: vaultLookupError } = await supabaseAdmin
    .rpc('get_vault_secret_id', { secret_name: account.id })

  if (vaultLookupError) {
    console.error('Vault lookup error:', JSON.stringify(vaultLookupError))
    return new Response('Failed to access vault', { status: 500 })
  }

  if (existingSecretId) {
    const { error: updateErr } = await supabaseAdmin.rpc('vault_update_secret', {
      secret_id: existingSecretId,
      new_secret: tokens.refresh_token,
    })
    if (updateErr) {
      console.error('Vault update error:', JSON.stringify(updateErr))
      return new Response('Failed to update vault secret', { status: 500 })
    }
  } else {
    const { error: createErr } = await supabaseAdmin.rpc('vault_create_secret', {
      secret: tokens.refresh_token,
      name: account.id,
      description: `OAuth refresh token for ${emailAddress}`,
    })
    if (createErr) {
      console.error('Vault create error:', JSON.stringify(createErr))
      return new Response('Failed to store vault secret', { status: 500 })
    }
  }

  // Vault write succeeded — mark account active
  await supabaseAdmin
    .from('connected_accounts')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', account.id)

  // access_token is ephemeral — never stored
  return Response.redirect(`${siteUrl}/accounts`, 302)
})

exec
/bin/zsh -lc "sed -n '1,260p' supabase/functions/google-oauth-initiate/index.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ')
const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function buildStateJwt(userId: string, stateSecret: string): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    user_id: userId,
    nonce: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 300,
  })))
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stateSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(sig)}`
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const stateSecret = Deno.env.get('STATE_SECRET')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
  }

  const state = await buildStateJwt(user.id, stateSecret)

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`
  return Response.json({ url }, { headers: corsHeaders })
})

exec
/bin/zsh -lc "sed -n '1,220p' supabase/migrations/20260617000002_vault_helpers.sql && sed -n '1,220p' supabase/migrations/20260617000003_cron_collector.sql" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
CREATE OR REPLACE FUNCTION vault_create_secret(
  secret text,
  name text,
  description text DEFAULT ''
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT vault.create_secret(secret, name, description);
$$;

CREATE OR REPLACE FUNCTION vault_update_secret(
  secret_id uuid,
  new_secret text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT vault.update_secret(secret_id, new_secret);
$$;

CREATE OR REPLACE FUNCTION get_vault_secret(secret_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = secret_name LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_vault_secret_id(secret_name text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT id FROM vault.secrets WHERE name = secret_name LIMIT 1;
$$;

REVOKE ALL ON FUNCTION vault_create_secret(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault_update_secret(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_vault_secret_id(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION vault_create_secret(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION vault_update_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION get_vault_secret(text) TO service_role;
GRANT EXECUTE ON FUNCTION get_vault_secret_id(text) TO service_role;
-- Schedule gmail-collector to run every 5 minutes via pg_cron + pg_net
DO $$
BEGIN
  PERFORM cron.unschedule('collect-gmail-every-5min');
EXCEPTION WHEN others THEN
  NULL;
END $$;

SELECT cron.schedule(
  'collect-gmail-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/gmail-collector',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'CRON_SECRET'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

codex
A few implementation risks are already visible: the collector currently updates cursors after every account run even if individual message fetches fail, and the message list service currently returns only message columns. I’m checking the UI and tests next because EU-15’s account badge probably needs account data that the plan has not named.
exec
/bin/zsh -lc "sed -n '1,220p' src/components/email/MessageItem.tsx" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,260p' src/components/email/EmailPage.tsx" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import type { MessageListItem } from '@/services/messages.service'
import styles from './MessageItem.module.scss'

interface Props {
  message: MessageListItem
  isSelected: boolean
  onClick: () => void
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function extractSenderName(from: string | null): string {
  if (!from) return '(unknown)'
  const match = from.match(/^"?([^"<]+)"?\s*<?/)
  return match ? match[1].trim() : from
}

export default function MessageItem({ message, isSelected, onClick }: Props) {
  return (
    <button
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles.sender}>{extractSenderName(message.from_address)}</div>
      <div className={styles.date}>{formatDate(message.internal_date)}</div>
      <div className={styles.subject}>{message.subject || '(no subject)'}</div>
      <div className={styles.snippet}>{message.snippet}</div>
    </button>
  )
}

 succeeded in 0ms:
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { useMessages } from '@/hooks/useMessages'
import { useMessage } from '@/hooks/useMessage'
import MessageList from './MessageList'
import MessageDetail from './MessageDetail'
import EmptyState from '@/components/shared/EmptyState'
import styles from './EmailPage.module.scss'

export default function EmailPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  const { data: accounts, isLoading: accountsLoading } = useAccounts()
  const { data: messages, isLoading: messagesLoading } = useMessages()
  const { data: selectedMessage, isLoading: messageLoading } = useMessage(selectedId)

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setShowDetail(true)
  }

  const noAccounts = !accountsLoading && accounts && accounts.length === 0
  const hasMessages = messages && messages.length > 0
  const noMessages = !messagesLoading && accounts && accounts.length > 0 && messages && messages.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Emails</h1>
      </header>

      <div className={styles.layout}>
        <div className={`${styles.listPane} ${showDetail ? styles.hidden : ''}`}>
          {noAccounts && (
            <EmptyState
              message="Connect a Gmail account to get started."
              action={{ label: 'Go to Accounts', onClick: () => navigate('/accounts') }}
            />
          )}
          {noMessages && (
            <EmptyState message="Your emails are being collected. Check back in a few minutes." />
          )}
          {!noAccounts && messagesLoading && (
            <p className={styles.loading}>Loading…</p>
          )}
          {hasMessages && (
            <MessageList
              messages={messages}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </div>

        <div className={`${styles.detailPane} ${showDetail ? styles.visible : ''}`}>
          {showDetail && (
            <button className={styles.backToList} onClick={() => setShowDetail(false)}>
              ← Back
            </button>
          )}
          <MessageDetail
            message={selectedMessage}
            isLoading={!!selectedId && messageLoading}
          />
        </div>
      </div>
    </div>
  )
}

exec
/bin/zsh -lc "sed -n '1,220p' src/components/email/MessageList.tsx" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import type { MessageListItem } from '@/services/messages.service'
import MessageItem from './MessageItem'
import styles from './MessageList.module.scss'

interface Props {
  messages: MessageListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export default function MessageList({ messages, selectedId, onSelect }: Props) {
  return (
    <div className={styles.list}>
      {messages.map(msg => (
        <MessageItem
          key={msg.id}
          message={msg}
          isSelected={msg.id === selectedId}
          onClick={() => onSelect(msg.id)}
        />
      ))}
    </div>
  )
}

exec
/bin/zsh -lc "sed -n '1,220p' src/hooks/useMessages.ts && sed -n '1,160p' src/hooks/useAccounts.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { useQuery } from '@tanstack/react-query'
import { getMessages } from '@/services/messages.service'

export function useMessages() {
  return useQuery({
    queryKey: ['messages'],
    queryFn: getMessages,
    refetchInterval: 60_000,
  })
}
import { useQuery } from '@tanstack/react-query'
import { getAccounts } from '@/services/accounts.service'

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: getAccounts,
  })
}

exec
/bin/zsh -lc "sed -n '1,280p' src/services/messages.service.test.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,220p' src/components/email/MessageItem.module.scss" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { getMessages, getMessage } from './messages.service'

const mockRange = jest.fn()
const mockOrder = jest.fn(() => ({ range: mockRange }))
const mockSingle = jest.fn()
const mockEq = jest.fn(() => ({ single: mockSingle }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: mockOrder,
        eq: mockEq,
      })),
    })),
  },
}))

describe('messages.service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('getMessages', () => {
    it('returns empty array when no messages', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      const result = await getMessages()
      expect(result).toEqual([])
    })

    it('throws when supabase returns error', async () => {
      mockRange.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(getMessages()).rejects.toThrow('DB error')
    })
  })

  describe('getMessage', () => {
    it('returns null when not found (PGRST116)', async () => {
      mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      const result = await getMessage('123')
      expect(result).toBeNull()
    })

    it('throws on non-404 error', async () => {
      mockSingle.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(getMessage('123')).rejects.toThrow('DB error')
    })
  })
})

 succeeded in 0ms:
@use '@/styles/tokens' as *;

.item {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 2px $spacing-sm;
  width: 100%;
  padding: $spacing-sm $spacing-md;
  background: transparent;
  border: none;
  border-bottom: 1px solid $color-border;
  text-align: left;
  cursor: pointer;
  transition: background $transition-fast;

  &:hover {
    background: $color-surface-alt;
  }

  &.selected {
    background: #e8f0fe;
  }
}

.sender {
  font-weight: 600;
  font-size: $font-size-base;
  color: $color-text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.date {
  font-size: $font-size-sm;
  color: $color-text-secondary;
  white-space: nowrap;
}

.subject {
  grid-column: 1 / -1;
  font-size: $font-size-base;
  color: $color-text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.snippet {
  grid-column: 1 / -1;
  font-size: $font-size-sm;
  color: $color-text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

exec
/bin/zsh -lc "sed -n '1,220p' src/components/email/EmailPage.module.scss" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
@use '@/styles/tokens' as *;

.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  gap: $spacing-md;
  padding: $spacing-sm $spacing-md;
  background: $color-surface;
  border-bottom: 1px solid $color-border;
  flex-shrink: 0;
}

.back {
  background: none;
  border: none;
  color: $color-primary;
  font-size: $font-size-base;
  cursor: pointer;
  padding: $spacing-xs $spacing-sm;
}

.title {
  font-size: $font-size-md;
  font-weight: 600;
  margin: 0;
}

.layout {
  display: grid;
  grid-template-columns: 35% 65%;
  flex: 1;
  overflow: hidden;
}

.listPane {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detailPane {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: $color-surface;
}

.backToList {
  display: none;
  background: none;
  border: none;
  border-bottom: 1px solid $color-border;
  color: $color-primary;
  font-size: $font-size-base;
  cursor: pointer;
  padding: $spacing-sm $spacing-md;
  text-align: left;
}

.loading {
  padding: $spacing-xl;
  color: $color-text-secondary;
  text-align: center;
}

@media (width <= 640px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .listPane.hidden {
    display: none;
  }

  .detailPane {
    display: none;

    &.visible {
      display: flex;
    }
  }

  .backToList {
    display: block;
  }
}

exec
/bin/zsh -lc "sed -n '1,320p' src/components/email/EmailPage.test.tsx" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmailPage from './EmailPage'

const mockOrder = jest.fn(() => Promise.resolve({ data: [], error: null }))
const mockSingle = jest.fn(() => Promise.resolve({ data: null, error: null }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: mockOrder,
        eq: jest.fn(() => ({ single: mockSingle })),
      })),
    })),
  },
}))

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}))

function renderEmailPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('EmailPage', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders header with Emails title', () => {
    renderEmailPage()
    expect(screen.getByText('Emails')).toBeInTheDocument()
  })

  it('renders empty state when no accounts', async () => {
    renderEmailPage()
    expect(await screen.findByText(/connect a gmail account/i)).toBeInTheDocument()
  })
})

codex
The UI path confirms EU-15 is underspecified: `MessageItem` only receives the message row, while the desired email-address badge comes from `connected_accounts.email_address`, which is not selected by `getMessages()`. I’m checking package scripts and generated types so the review can call out migration and hook risks precisely.
exec
/bin/zsh -lc "sed -n '1,220p' package.json" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
{
  "name": "gmail-knowledge-collector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts,.tsx && stylelint 'src/**/*.scss'",
    "test": "jest",
    "preview": "vite preview",
    "gen:types": "supabase gen types typescript --project-id ybgtzyutbvwfhgtlmnah --schema public > src/types/database.types.ts"
  },
  "dependencies": {
    "@hookform/resolvers": "^5.4.0",
    "@supabase/supabase-js": "^2.108.2",
    "@tanstack/react-query": "^5.101.0",
    "@vitejs/plugin-react": "^6.0.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-hook-form": "^7.79.0",
    "react-router-dom": "^7.18.0",
    "vite": "^8.0.16",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/jest": "^30.0.0",
    "@types/node": "^25.9.3",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@typescript-eslint/eslint-plugin": "^8.61.1",
    "@typescript-eslint/parser": "^8.61.1",
    "eslint": "^9.39.4",
    "eslint-plugin-react": "^7.37.5",
    "eslint-plugin-react-hooks": "^7.1.1",
    "jest": "^30.4.2",
    "jest-environment-jsdom": "^30.4.1",
    "sass": "^1.101.0",
    "stylelint": "^17.13.0",
    "stylelint-config-standard-scss": "^17.0.0",
    "ts-jest": "^29.4.11",
    "typescript": "^6.0.3"
  }
}

exec
/bin/zsh -lc 'rg -n "connected_accounts|messages|backfill|sync_cursor|Database" src/types/database.types.ts' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
9:export type Database = {
11:  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
17:      connected_accounts: {
26:          sync_cursor: string | null
38:          sync_cursor?: string | null
50:          sync_cursor?: string | null
56:      messages: {
107:            foreignKeyName: "messages_connected_account_id_fkey"
110:            referencedRelation: "connected_accounts"
131:type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">
133:type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]
138:    | { schema: keyof DatabaseWithoutInternals },
140:    schema: keyof DatabaseWithoutInternals
142:    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
143:        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
146:  schema: keyof DatabaseWithoutInternals
148:  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
149:      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
167:    | { schema: keyof DatabaseWithoutInternals },
169:    schema: keyof DatabaseWithoutInternals
171:    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
174:  schema: keyof DatabaseWithoutInternals
176:  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
192:    | { schema: keyof DatabaseWithoutInternals },
194:    schema: keyof DatabaseWithoutInternals
196:    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
199:  schema: keyof DatabaseWithoutInternals
201:  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
217:    | { schema: keyof DatabaseWithoutInternals },
219:    schema: keyof DatabaseWithoutInternals
221:    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
224:  schema: keyof DatabaseWithoutInternals
226:  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
234:    | { schema: keyof DatabaseWithoutInternals },
236:    schema: keyof DatabaseWithoutInternals
238:    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
241:  schema: keyof DatabaseWithoutInternals
243:  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]

exec
/bin/zsh -lc "sed -n '1,260p' README.md" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,260p' docs/project-brief.md" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,130p' src/types/database.types.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,260p' src/components/email/MessageDetail.tsx" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "sed -n '1,220p' src/services/accounts.service.test.ts" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
import type { Message } from '@/services/messages.service'
import styles from './MessageDetail.module.scss'

interface Props {
  message: Message | null | undefined
  isLoading: boolean
}

function wrapWithCsp(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
  return `<!DOCTYPE html><html><head>${csp}</head><body>${html}</body></html>`
}

function formatFullDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function MessageDetail({ message, isLoading }: Props) {
  if (isLoading) {
    return <div className={styles.empty}>Loading…</div>
  }

  if (!message) {
    return <div className={styles.empty}>Select a message to read it.</div>
  }

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <h2 className={styles.subject}>{message.subject || '(no subject)'}</h2>
        <div className={styles.meta}>
          <span><strong>From:</strong> {message.from_address}</span>
          <span><strong>To:</strong> {message.to_addresses}</span>
          <span><strong>Date:</strong> {formatFullDate(message.internal_date)}</span>
        </div>
      </div>
      <div className={styles.body}>
        {message.body_html ? (
          <iframe
            srcDoc={wrapWithCsp(message.body_html)}
            sandbox=""
            className={styles.iframe}
            title={message.subject ?? 'Email content'}
          />
        ) : message.body_text ? (
          <pre className={styles.text}>{message.body_text}</pre>
        ) : (
          <p className={styles.noContent}>No content available for this message.</p>
        )}
      </div>
    </div>
  )
}

 succeeded in 0ms:
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      connected_accounts: {
        Row: {
          created_at: string
          email_address: string
          granted_scopes: string | null
          id: string
          last_synced_at: string | null
          provider: string
          status: string
          sync_cursor: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_address: string
          granted_scopes?: string | null
          id?: string
          last_synced_at?: string | null
          provider?: string
          status?: string
          sync_cursor?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_address?: string
          granted_scopes?: string | null
          id?: string
          last_synced_at?: string | null
          provider?: string
          status?: string
          sync_cursor?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          body_html: string | null
          body_text: string | null
          connected_account_id: string
          fetched_at: string
          from_address: string | null
          gmail_message_id: string
          id: string
          internal_date: string | null
          label_ids: string[] | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_addresses: string | null
          user_id: string
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          connected_account_id: string
          fetched_at?: string
          from_address?: string | null
          gmail_message_id: string
          id?: string
          internal_date?: string | null
          label_ids?: string[] | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string | null
          user_id: string
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          connected_account_id?: string
          fetched_at?: string
          from_address?: string | null
          gmail_message_id?: string
          id?: string
          internal_date?: string | null
          label_ids?: string[] | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addresses?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_connected_account_id_fkey"
            columns: ["connected_account_id"]
            isOneToOne: false
            referencedRelation: "connected_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}


 succeeded in 0ms:
import { getAccounts } from './accounts.service'

const mockOrder = jest.fn()
const mockSelect = jest.fn(() => ({ order: mockOrder }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFrom = jest.fn((_table: string): any => ({ select: mockSelect }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    functions: { invoke: jest.fn() },
  },
}))

beforeEach(() => {
  mockOrder.mockResolvedValue({ data: [], error: null })
})

afterEach(() => {
  jest.clearAllMocks()
})

describe('accounts.service', () => {
  it('returns empty array when no accounts', async () => {
    const result = await getAccounts()
    expect(result).toEqual([])
  })

  it('throws when supabase returns error', async () => {
    mockOrder.mockResolvedValue({ data: null, error: new Error('DB error') })
    await expect(getAccounts()).rejects.toThrow('DB error')
  })

  it('queries connected_accounts ordered by created_at desc', async () => {
    await getAccounts()
    expect(mockFrom).toHaveBeenCalledWith('connected_accounts')
    expect(mockSelect).toHaveBeenCalledWith('*')
    expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false })
  })
})

exec
/bin/zsh -lc 'rg -n "cron|collector|edge|supabase functions|migration|gen:types|safety|RLS|Vault|token|messages" docs/dev-rules.md README.md CLAUDE.md' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
CLAUDE.md:1:# CLAUDE.md — Gmail Knowledge Collector
CLAUDE.md:11:**Repo:** `gmail-knowledge-collector` (Google path only)  
CLAUDE.md:23:2. **OAuth tokens are server-side only.** Refresh and access tokens live in Supabase Vault or a table with no `authenticated` RLS SELECT policy. They are never returned to the browser, never logged, never committed.
CLAUDE.md:25:3. **The browser is read-only on `messages`.** No INSERT, UPDATE, or DELETE RLS policies for `authenticated` on that table. Only the collector edge function writes, via service role.
CLAUDE.md:27:4. **RLS on every table.** Policies scoped `TO authenticated` with `(select auth.uid())` (cached form — never bare `auth.uid()`). Separate policy per operation. Index every column in a policy condition.
CLAUDE.md:29:5. **All migrations idempotent.** Every DDL uses `IF NOT EXISTS` / `IF EXISTS`. Never edit an applied migration — create a new one.
CLAUDE.md:31:6. **Type generation is paired with migrations.** After every `npx supabase db push --linked`, run `npm run gen:types` and commit the updated `src/types/database.types.ts` alongside the migration file.
CLAUDE.md:33:7. **Secrets never enter git.** `.gitignore` excludes `.env`, `.env.*`, `.claude/settings.local.json`. Edge function secrets come from Supabase Vault via `Deno.env.get()` only.
CLAUDE.md:47:| Styles | SCSS + design tokens (no Tailwind) |
CLAUDE.md:48:| Backend | Supabase (Postgres + Auth + RLS + Edge Functions) |
CLAUDE.md:61:npm run gen:types    # Regenerate database.types.ts from Supabase schema
CLAUDE.md:62:npx supabase migration list --linked   # Migration deploy gate check
CLAUDE.md:63:npx supabase functions deploy <name>   # Deploy an edge function
CLAUDE.md:76:  functions/        # Edge functions (google-oauth-callback, gmail-collector)
CLAUDE.md:77:  migrations/       # Append-only SQL migration files
CLAUDE.md:97:| 3. Build | All issues implemented, app runs, migrations in Remote column |
CLAUDE.md:100:| 6. Validate | TypeScript, lint, tests, migration check all pass |
docs/dev-rules.md:149:If you add a migration:
docs/dev-rules.md:153:npx supabase migration new your_description_here
docs/dev-rules.md:155:# 2. Edit the generated file in supabase/migrations/
docs/dev-rules.md:159:# psql> \i supabase/migrations/<timestamp>_your_description.sql
docs/dev-rules.md:166:npx supabase migration list --linked
docs/dev-rules.md:169:npm run gen:types
docs/dev-rules.md:172:git add supabase/migrations/ src/types/database.types.ts
docs/dev-rules.md:173:git commit -m "feat(scope): add migration + regen types"
docs/dev-rules.md:229:# Confirm migration gate — every migration in this branch must appear in Remote
docs/dev-rules.md:230:npx supabase migration list --linked
docs/dev-rules.md:268:### Step 10 — Knowledge Persistence
docs/dev-rules.md:273:# Apply migrations to the test DB (if this epic had migrations)
docs/dev-rules.md:276:npx supabase migration list --linked   # confirm new timestamp appears as applied
docs/dev-rules.md:296:These are rules captured directly from calls and messages, organized by topic.
docs/dev-rules.md:349:**Why this rule exists:** In May 2026, 47 migrations silently piled up over 3 months. Migration files were merged into `test` and `main` without ever being applied to the shared Supabase DB. The Supabase Preview CI check only validates against an ephemeral preview DB — it does NOT update the shared production DB. The fix took hours.
docs/dev-rules.md:351:**The rule:** Any PR that adds or modifies files under `supabase/migrations/` **must** have those migrations applied to the linked DB before the PR is opened. This is a precondition, not a post-merge step.
docs/dev-rules.md:356:npx supabase migration list --linked
docs/dev-rules.md:357:# Every migration added in this branch must appear in BOTH Local and Remote columns.
docs/dev-rules.md:372:**Never edit an already-applied migration.** Create a new one to fix mistakes.
docs/dev-rules.md:390:| 10   | Knowledge Persistence     | Memory doc + wiki sync                       |
docs/dev-rules.md:399:Before writing any SQL or migration, query `information_schema` for exact column names on every table you'll touch. Verify first, then draft SQL — avoid naming errors (`company_name` vs `name`, `is_system_admin` vs `is_super_admin`, assumed `updated_at` columns).
docs/dev-rules.md:403:### Database — RLS Policies
docs/dev-rules.md:405:- Always enable RLS on new tables (`ALTER TABLE x ENABLE ROW LEVEL SECURITY`)
docs/dev-rules.md:409:- Never skip RLS on new tenant-scoped tables — tenant isolation is enforced through RLS, not application-layer filters
README.md:1:# Gmail Knowledge Collector (Google Path)
README.md:7:The AI pod at Big Impact Group is building a reusable platform that captures institutional knowledge of public sector workers by collecting their work data, starting with email. This repository is the **Google path** of that platform. A separate repository handles the Microsoft 365 path.
README.md:27:| Styles | SCSS with design tokens — no Tailwind; Stylelint gate enforced |
README.md:28:| Backend | Supabase (PostgreSQL + Auth + RLS + Edge Functions) |
README.md:35:**Edge functions:** Follow the momentum edge function pattern. This project uses them for the OAuth callback (`google-oauth-callback`) and the email collector (`gmail-collector`).
README.md:37:**RLS:** Enable on every table. Policies scoped `TO authenticated` with `(select auth.uid())` (never bare `auth.uid()` — performance). Separate policy per operation. Index columns used in policy conditions.
README.md:39:**Migrations:** Append-only, cloud-only, idempotent (`IF NOT EXISTS` / `IF EXISTS` everywhere). Commit paired TypeScript type generation alongside every migration.
README.md:61:RLS: authenticated users can SELECT their own rows. No browser INSERT/UPDATE/DELETE.
README.md:63:### `messages`
README.md:69:| user_id | uuid | Denormalized for cached RLS subselect |
README.md:84:RLS: authenticated users can SELECT their own rows only. No browser writes. The collector edge function writes via service role.
README.md:88:OAuth refresh tokens are stored in Supabase Vault (or a service-role-only table with no authenticated RLS SELECT policy). They are never returned to the browser, never logged, never committed to git.
README.md:104:   |                            |-- exchange code for tokens --→|
README.md:105:   |                            |← refresh + access tokens ----||
README.md:106:   |                            |-- store refresh token in Vault
README.md:116:Supabase Cron (pg_cron + pg_net)
README.md:118:   |-- HTTP POST every N minutes → gmail-collector edge function
README.md:122:                                        |     fetch refresh token from Vault
README.md:123:                                        |     exchange for access token
README.md:124:                                        |     fetch new messages (incremental, historyId cursor)
README.md:126:                                        |     upsert into messages (service role)
README.md:130:Cron invocation keys are read from Supabase Vault — never inline in SQL.
README.md:140:**In scope:** Supabase Auth login, connect Google account OAuth flow, scheduled collector, two-pane email viewer, Netlify deployment.
README.md:148:- Edge Functions deployed with `supabase functions deploy`
README.md:151:## 9. Mandatory safety rules
README.md:156:OAuth refresh and access tokens are stored encrypted in Supabase Vault or a table with no `authenticated` RLS SELECT policy. They are never returned to the browser, never selectable through any service, never logged, and never committed to git. Only edge functions under the service role may read them.
README.md:159:There are no INSERT, UPDATE, or DELETE RLS policies for `authenticated` on the `messages` table. The collector edge function writes via the service role only.
README.md:165:`.gitignore` excludes `.env`, `.env.*`, and `.claude/settings.local.json`. Edge function secrets are stored in Supabase Vault and accessed via `Deno.env.get()` — never hardcoded.
README.md:181:npx supabase migration list --linked   # Verify migration deploy gate

codex
The generated types still reflect the current schema only, so EU-14 must explicitly include `src/types/database.types.ts`; otherwise TypeScript will reject any `backfill_complete`/`backfill_page_token` access from the collector query shape. I’m grabbing line-numbered excerpts for the findings now.
exec
/bin/zsh -lc "nl -ba src/services/messages.service.ts | sed -n '1,120p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "nl -ba src/components/email/EmailPage.tsx | sed -n '1,160p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "nl -ba supabase/functions/gmail-collector/index.ts | sed -n '85,250p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import { supabase } from '@/lib/supabase'
     2	import type { Tables } from '@/types/database.types'
     3	
     4	export type Message = Tables<'messages'>
     5	export type MessageListItem = Pick<Message, 'id' | 'from_address' | 'subject' | 'snippet' | 'internal_date' | 'connected_account_id'>
     6	
     7	export async function getMessages(): Promise<MessageListItem[]> {
     8	  const { data, error } = await supabase
     9	    .from('messages')
    10	    .select('id, from_address, subject, snippet, internal_date, connected_account_id')
    11	    .order('internal_date', { ascending: false })
    12	    .range(0, 199)
    13	
    14	  if (error) throw error
    15	  return data
    16	}
    17	
    18	export async function getMessage(id: string): Promise<Message | null> {
    19	  const { data, error } = await supabase
    20	    .from('messages')
    21	    .select('*')
    22	    .eq('id', id)
    23	    .single()
    24	
    25	  if (error) {
    26	    // PGRST116 = no rows returned
    27	    if ((error as { code?: string }).code === 'PGRST116') return null
    28	    throw error
    29	  }
    30	  return data
    31	}

 succeeded in 0ms:
    85	      tokenError: (err as Record<string, string>).error,
    86	    })
    87	  }
    88	  const data = await res.json() as { access_token: string }
    89	  return data.access_token
    90	}
    91	
    92	async function fetchFullMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
    93	  const res = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    94	    headers: { Authorization: `Bearer ${accessToken}` },
    95	  })
    96	  if (!res.ok) throw new Error(`Failed to fetch message ${messageId}`)
    97	  return res.json()
    98	}
    99	
   100	Deno.serve(async (req: Request) => {
   101	  const cronSecret = Deno.env.get('CRON_SECRET')!
   102	  const authHeader = req.headers.get('Authorization')
   103	  if (authHeader !== `Bearer ${cronSecret}`) {
   104	    return new Response('Unauthorized', { status: 401 })
   105	  }
   106	
   107	  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
   108	  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
   109	  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
   110	  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
   111	
   112	  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
   113	
   114	  const { data: accounts, error: accountsError } = await supabaseAdmin
   115	    .from('connected_accounts')
   116	    .select('id, user_id, email_address, sync_cursor')
   117	    .eq('status', 'active')
   118	
   119	  if (accountsError) {
   120	    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 })
   121	  }
   122	
   123	  let processed = 0
   124	  let errors = 0
   125	
   126	  for (const account of (accounts ?? [])) {
   127	    try {
   128	      const { data: refreshToken } = await supabaseAdmin
   129	        .rpc('get_vault_secret', { secret_name: account.id })
   130	
   131	      if (!refreshToken) {
   132	        console.error(`No vault secret for account ${account.id}`)
   133	        errors++
   134	        continue
   135	      }
   136	
   137	      let accessToken: string
   138	      try {
   139	        accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
   140	      } catch (err: unknown) {
   141	        const tokenErr = err as { tokenError?: string }
   142	        if (tokenErr.tokenError === 'invalid_grant' || tokenErr.tokenError === 'token_revoked') {
   143	          await supabaseAdmin
   144	            .from('connected_accounts')
   145	            .update({ status: 'error', updated_at: new Date().toISOString() })
   146	            .eq('id', account.id)
   147	        }
   148	        errors++
   149	        continue
   150	      }
   151	
   152	      let messageIds: string[] = []
   153	      let newCursor: string | null = null
   154	
   155	      if (!account.sync_cursor) {
   156	        const res = await fetch(
   157	          `${GMAIL_API}/users/me/messages?maxResults=200`,
   158	          { headers: { Authorization: `Bearer ${accessToken}` } },
   159	        )
   160	        if (!res.ok) { errors++; continue }
   161	        const data = await res.json() as { messages?: Array<{ id: string }> }
   162	        messageIds = (data.messages ?? []).map(m => m.id)
   163	        // messages.list has no historyId — fetch it from profile
   164	        const profileRes = await fetch(
   165	          `${GMAIL_API}/users/me/profile`,
   166	          { headers: { Authorization: `Bearer ${accessToken}` } },
   167	        )
   168	        if (profileRes.ok) {
   169	          const profile = await profileRes.json() as { historyId?: string }
   170	          newCursor = profile.historyId ?? null
   171	        }
   172	      } else {
   173	        const res = await fetch(
   174	          `${GMAIL_API}/users/me/history?startHistoryId=${account.sync_cursor}&historyTypes=messageAdded`,
   175	          { headers: { Authorization: `Bearer ${accessToken}` } },
   176	        )
   177	        if (!res.ok) {
   178	          if (res.status === 404) {
   179	            // Cursor too old — reset so next run does a full resync
   180	            await supabaseAdmin
   181	              .from('connected_accounts')
   182	              .update({ sync_cursor: null, updated_at: new Date().toISOString() })
   183	              .eq('id', account.id)
   184	          }
   185	          errors++
   186	          continue
   187	        }
   188	        const data = await res.json() as {
   189	          history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>
   190	          historyId?: string
   191	        }
   192	        newCursor = data.historyId ?? account.sync_cursor
   193	        messageIds = (data.history ?? [])
   194	          .flatMap(h => h.messagesAdded ?? [])
   195	          .map(m => m.message.id)
   196	      }
   197	
   198	      for (const msgId of messageIds) {
   199	        try {
   200	          const msg = await fetchFullMessage(accessToken, msgId)
   201	          const headers = msg.payload?.headers
   202	          const { text, html } = extractBody(msg.payload)
   203	
   204	          await supabaseAdmin.from('messages').upsert({
   205	            connected_account_id: account.id,
   206	            user_id: account.user_id,
   207	            gmail_message_id: msg.id,
   208	            thread_id: msg.threadId ?? null,
   209	            from_address: getHeader(headers, 'from'),
   210	            to_addresses: getHeader(headers, 'to'),
   211	            subject: getHeader(headers, 'subject'),
   212	            snippet: msg.snippet ?? null,
   213	            internal_date: msg.internalDate
   214	              ? new Date(parseInt(msg.internalDate)).toISOString()
   215	              : null,
   216	            body_text: text,
   217	            body_html: html,
   218	            label_ids: msg.labelIds ?? null,
   219	          }, { onConflict: 'connected_account_id,gmail_message_id', ignoreDuplicates: true })
   220	
   221	          processed++
   222	        } catch {
   223	          // Skip individual message failures
   224	        }
   225	      }
   226	
   227	      await supabaseAdmin
   228	        .from('connected_accounts')
   229	        .update({
   230	          sync_cursor: newCursor,
   231	          last_synced_at: new Date().toISOString(),
   232	          updated_at: new Date().toISOString(),
   233	        })
   234	        .eq('id', account.id)
   235	
   236	    } catch {
   237	      errors++
   238	    }
   239	  }
   240	
   241	  return Response.json({ processed, errors, accounts: accounts?.length ?? 0 })
   242	})

 succeeded in 0ms:
     1	import { useState } from 'react'
     2	import { useNavigate } from 'react-router-dom'
     3	import { useAccounts } from '@/hooks/useAccounts'
     4	import { useMessages } from '@/hooks/useMessages'
     5	import { useMessage } from '@/hooks/useMessage'
     6	import MessageList from './MessageList'
     7	import MessageDetail from './MessageDetail'
     8	import EmptyState from '@/components/shared/EmptyState'
     9	import styles from './EmailPage.module.scss'
    10	
    11	export default function EmailPage() {
    12	  const navigate = useNavigate()
    13	  const [selectedId, setSelectedId] = useState<string | null>(null)
    14	  const [showDetail, setShowDetail] = useState(false)
    15	
    16	  const { data: accounts, isLoading: accountsLoading } = useAccounts()
    17	  const { data: messages, isLoading: messagesLoading } = useMessages()
    18	  const { data: selectedMessage, isLoading: messageLoading } = useMessage(selectedId)
    19	
    20	  const handleSelect = (id: string) => {
    21	    setSelectedId(id)
    22	    setShowDetail(true)
    23	  }
    24	
    25	  const noAccounts = !accountsLoading && accounts && accounts.length === 0
    26	  const hasMessages = messages && messages.length > 0
    27	  const noMessages = !messagesLoading && accounts && accounts.length > 0 && messages && messages.length === 0
    28	
    29	  return (
    30	    <div className={styles.page}>
    31	      <header className={styles.header}>
    32	        <button className={styles.back} onClick={() => navigate('/accounts')}>
    33	          ← Accounts
    34	        </button>
    35	        <h1 className={styles.title}>Emails</h1>
    36	      </header>
    37	
    38	      <div className={styles.layout}>
    39	        <div className={`${styles.listPane} ${showDetail ? styles.hidden : ''}`}>
    40	          {noAccounts && (
    41	            <EmptyState
    42	              message="Connect a Gmail account to get started."
    43	              action={{ label: 'Go to Accounts', onClick: () => navigate('/accounts') }}
    44	            />
    45	          )}
    46	          {noMessages && (
    47	            <EmptyState message="Your emails are being collected. Check back in a few minutes." />
    48	          )}
    49	          {!noAccounts && messagesLoading && (
    50	            <p className={styles.loading}>Loading…</p>
    51	          )}
    52	          {hasMessages && (
    53	            <MessageList
    54	              messages={messages}
    55	              selectedId={selectedId}
    56	              onSelect={handleSelect}
    57	            />
    58	          )}
    59	        </div>
    60	
    61	        <div className={`${styles.detailPane} ${showDetail ? styles.visible : ''}`}>
    62	          {showDetail && (
    63	            <button className={styles.backToList} onClick={() => setShowDetail(false)}>
    64	              ← Back
    65	            </button>
    66	          )}
    67	          <MessageDetail
    68	            message={selectedMessage}
    69	            isLoading={!!selectedId && messageLoading}
    70	          />
    71	        </div>
    72	      </div>
    73	    </div>
    74	  )
    75	}

exec
/bin/zsh -lc "nl -ba src/components/email/MessageItem.tsx | sed -n '1,120p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import type { MessageListItem } from '@/services/messages.service'
     2	import styles from './MessageItem.module.scss'
     3	
     4	interface Props {
     5	  message: MessageListItem
     6	  isSelected: boolean
     7	  onClick: () => void
     8	}
     9	
    10	function formatDate(dateStr: string | null): string {
    11	  if (!dateStr) return ''
    12	  const date = new Date(dateStr)
    13	  const now = new Date()
    14	  const diffMs = now.getTime() - date.getTime()
    15	  const diffDays = Math.floor(diffMs / 86400000)
    16	  if (diffDays === 0) {
    17	    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    18	  }
    19	  if (diffDays < 7) {
    20	    return date.toLocaleDateString([], { weekday: 'short' })
    21	  }
    22	  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    23	}
    24	
    25	function extractSenderName(from: string | null): string {
    26	  if (!from) return '(unknown)'
    27	  const match = from.match(/^"?([^"<]+)"?\s*<?/)
    28	  return match ? match[1].trim() : from
    29	}
    30	
    31	export default function MessageItem({ message, isSelected, onClick }: Props) {
    32	  return (
    33	    <button
    34	      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
    35	      onClick={onClick}
    36	    >
    37	      <div className={styles.sender}>{extractSenderName(message.from_address)}</div>
    38	      <div className={styles.date}>{formatDate(message.internal_date)}</div>
    39	      <div className={styles.subject}>{message.subject || '(no subject)'}</div>
    40	      <div className={styles.snippet}>{message.snippet}</div>
    41	    </button>
    42	  )
    43	}

exec
/bin/zsh -lc "nl -ba src/types/database.types.ts | sed -n '14,115p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "nl -ba supabase/migrations/20260617000001_initial_schema.sql | sed -n '1,130p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	-- connected_accounts: stores OAuth-connected Gmail accounts per user
     2	CREATE TABLE IF NOT EXISTS connected_accounts (
     3	  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     4	  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
     5	  provider          text NOT NULL DEFAULT 'google',
     6	  email_address     text NOT NULL,
     7	  status            text NOT NULL DEFAULT 'active'
     8	                    CONSTRAINT connected_accounts_status_check
     9	                    CHECK (status IN ('active', 'error', 'revoked')),
    10	  granted_scopes    text,
    11	  sync_cursor       text,
    12	  last_synced_at    timestamptz,
    13	  created_at        timestamptz NOT NULL DEFAULT now(),
    14	  updated_at        timestamptz NOT NULL DEFAULT now(),
    15	  CONSTRAINT connected_accounts_user_email_unique UNIQUE (user_id, email_address)
    16	);
    17	
    18	ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
    19	
    20	DO $$ BEGIN
    21	  IF NOT EXISTS (
    22	    SELECT 1 FROM pg_policies
    23	    WHERE tablename = 'connected_accounts' AND policyname = 'users select own accounts'
    24	  ) THEN
    25	    CREATE POLICY "users select own accounts"
    26	      ON connected_accounts
    27	      FOR SELECT
    28	      TO authenticated
    29	      USING ((select auth.uid()) = user_id);
    30	  END IF;
    31	END $$;
    32	
    33	CREATE INDEX IF NOT EXISTS connected_accounts_user_id_idx
    34	  ON connected_accounts (user_id);
    35	
    36	CREATE INDEX IF NOT EXISTS connected_accounts_user_id_status_idx
    37	  ON connected_accounts (user_id, status);
    38	
    39	-- messages: collected email messages, written only by the collector edge function
    40	CREATE TABLE IF NOT EXISTS messages (
    41	  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    42	  connected_account_id  uuid NOT NULL
    43	                        REFERENCES connected_accounts(id) ON DELETE CASCADE,
    44	  user_id               uuid NOT NULL,
    45	  gmail_message_id      text NOT NULL,
    46	  thread_id             text,
    47	  from_address          text,
    48	  to_addresses          text,
    49	  subject               text,
    50	  snippet               text,
    51	  internal_date         timestamptz,
    52	  body_text             text,
    53	  body_html             text,
    54	  label_ids             text[],
    55	  fetched_at            timestamptz NOT NULL DEFAULT now(),
    56	  CONSTRAINT messages_account_gmail_id_unique
    57	    UNIQUE (connected_account_id, gmail_message_id)
    58	);
    59	
    60	ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    61	
    62	DO $$ BEGIN
    63	  IF NOT EXISTS (
    64	    SELECT 1 FROM pg_policies
    65	    WHERE tablename = 'messages' AND policyname = 'users select own messages'
    66	  ) THEN
    67	    CREATE POLICY "users select own messages"
    68	      ON messages
    69	      FOR SELECT
    70	      TO authenticated
    71	      USING ((select auth.uid()) = user_id);
    72	  END IF;
    73	END $$;
    74	
    75	CREATE INDEX IF NOT EXISTS messages_user_id_internal_date_idx
    76	  ON messages (user_id, internal_date DESC);
    77	
    78	CREATE INDEX IF NOT EXISTS messages_user_id_account_id_internal_date_idx
    79	  ON messages (user_id, connected_account_id, internal_date DESC);
    80	
    81	CREATE INDEX IF NOT EXISTS messages_connected_account_id_idx
    82	  ON messages (connected_account_id);

 succeeded in 0ms:
    14	  }
    15	  public: {
    16	    Tables: {
    17	      connected_accounts: {
    18	        Row: {
    19	          created_at: string
    20	          email_address: string
    21	          granted_scopes: string | null
    22	          id: string
    23	          last_synced_at: string | null
    24	          provider: string
    25	          status: string
    26	          sync_cursor: string | null
    27	          updated_at: string
    28	          user_id: string
    29	        }
    30	        Insert: {
    31	          created_at?: string
    32	          email_address: string
    33	          granted_scopes?: string | null
    34	          id?: string
    35	          last_synced_at?: string | null
    36	          provider?: string
    37	          status?: string
    38	          sync_cursor?: string | null
    39	          updated_at?: string
    40	          user_id: string
    41	        }
    42	        Update: {
    43	          created_at?: string
    44	          email_address?: string
    45	          granted_scopes?: string | null
    46	          id?: string
    47	          last_synced_at?: string | null
    48	          provider?: string
    49	          status?: string
    50	          sync_cursor?: string | null
    51	          updated_at?: string
    52	          user_id?: string
    53	        }
    54	        Relationships: []
    55	      }
    56	      messages: {
    57	        Row: {
    58	          body_html: string | null
    59	          body_text: string | null
    60	          connected_account_id: string
    61	          fetched_at: string
    62	          from_address: string | null
    63	          gmail_message_id: string
    64	          id: string
    65	          internal_date: string | null
    66	          label_ids: string[] | null
    67	          snippet: string | null
    68	          subject: string | null
    69	          thread_id: string | null
    70	          to_addresses: string | null
    71	          user_id: string
    72	        }
    73	        Insert: {
    74	          body_html?: string | null
    75	          body_text?: string | null
    76	          connected_account_id: string
    77	          fetched_at?: string
    78	          from_address?: string | null
    79	          gmail_message_id: string
    80	          id?: string
    81	          internal_date?: string | null
    82	          label_ids?: string[] | null
    83	          snippet?: string | null
    84	          subject?: string | null
    85	          thread_id?: string | null
    86	          to_addresses?: string | null
    87	          user_id: string
    88	        }
    89	        Update: {
    90	          body_html?: string | null
    91	          body_text?: string | null
    92	          connected_account_id?: string
    93	          fetched_at?: string
    94	          from_address?: string | null
    95	          gmail_message_id?: string
    96	          id?: string
    97	          internal_date?: string | null
    98	          label_ids?: string[] | null
    99	          snippet?: string | null
   100	          subject?: string | null
   101	          thread_id?: string | null
   102	          to_addresses?: string | null
   103	          user_id?: string
   104	        }
   105	        Relationships: [
   106	          {
   107	            foreignKeyName: "messages_connected_account_id_fkey"
   108	            columns: ["connected_account_id"]
   109	            isOneToOne: false
   110	            referencedRelation: "connected_accounts"
   111	            referencedColumns: ["id"]
   112	          },
   113	        ]
   114	      }
   115	    }

exec
/bin/zsh -lc "nl -ba package.json | sed -n '1,80p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	{
     2	  "name": "gmail-knowledge-collector",
     3	  "version": "0.1.0",
     4	  "private": true,
     5	  "type": "module",
     6	  "scripts": {
     7	    "dev": "vite",
     8	    "build": "tsc && vite build",
     9	    "typecheck": "tsc --noEmit",
    10	    "lint": "eslint src --ext .ts,.tsx && stylelint 'src/**/*.scss'",
    11	    "test": "jest",
    12	    "preview": "vite preview",
    13	    "gen:types": "supabase gen types typescript --project-id ybgtzyutbvwfhgtlmnah --schema public > src/types/database.types.ts"
    14	  },
    15	  "dependencies": {
    16	    "@hookform/resolvers": "^5.4.0",
    17	    "@supabase/supabase-js": "^2.108.2",
    18	    "@tanstack/react-query": "^5.101.0",
    19	    "@vitejs/plugin-react": "^6.0.2",
    20	    "react": "^19.2.7",
    21	    "react-dom": "^19.2.7",
    22	    "react-hook-form": "^7.79.0",
    23	    "react-router-dom": "^7.18.0",
    24	    "vite": "^8.0.16",
    25	    "zod": "^4.4.3"
    26	  },
    27	  "devDependencies": {
    28	    "@testing-library/jest-dom": "^6.9.1",
    29	    "@testing-library/react": "^16.3.2",
    30	    "@testing-library/user-event": "^14.6.1",
    31	    "@types/jest": "^30.0.0",
    32	    "@types/node": "^25.9.3",
    33	    "@types/react": "^19.2.17",
    34	    "@types/react-dom": "^19.2.3",
    35	    "@typescript-eslint/eslint-plugin": "^8.61.1",
    36	    "@typescript-eslint/parser": "^8.61.1",
    37	    "eslint": "^9.39.4",
    38	    "eslint-plugin-react": "^7.37.5",
    39	    "eslint-plugin-react-hooks": "^7.1.1",
    40	    "jest": "^30.4.2",
    41	    "jest-environment-jsdom": "^30.4.1",
    42	    "sass": "^1.101.0",
    43	    "stylelint": "^17.13.0",
    44	    "stylelint-config-standard-scss": "^17.0.0",
    45	    "ts-jest": "^29.4.11",
    46	    "typescript": "^6.0.3"
    47	  }
    48	}

exec
/bin/zsh -lc "nl -ba README.md | sed -n '35,170p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
    35	**Edge functions:** Follow the momentum edge function pattern. This project uses them for the OAuth callback (`google-oauth-callback`) and the email collector (`gmail-collector`).
    36	
    37	**RLS:** Enable on every table. Policies scoped `TO authenticated` with `(select auth.uid())` (never bare `auth.uid()` — performance). Separate policy per operation. Index columns used in policy conditions.
    38	
    39	**Migrations:** Append-only, cloud-only, idempotent (`IF NOT EXISTS` / `IF EXISTS` everywhere). Commit paired TypeScript type generation alongside every migration.
    40	
    41	**Validation:** Zod schemas are the single source of truth. No duplicate validation logic.
    42	
    43	## 4. Data model
    44	
    45	### `connected_accounts`
    46	
    47	| Column | Type | Notes |
    48	|---|---|---|
    49	| id | uuid PK | |
    50	| user_id | uuid | FK → auth.users ON DELETE CASCADE |
    51	| provider | text | `'google'` |
    52	| email_address | text | The Gmail address |
    53	| status | text | CHECK: `'active' \| 'error' \| 'revoked'` |
    54	| granted_scopes | text | Space-separated OAuth scopes |
    55	| sync_cursor | text | Gmail historyId or last message ID |
    56	| last_synced_at | timestamptz | |
    57	| created_at | timestamptz | |
    58	| updated_at | timestamptz | |
    59	| | UNIQUE | `(user_id, email_address)` |
    60	
    61	RLS: authenticated users can SELECT their own rows. No browser INSERT/UPDATE/DELETE.
    62	
    63	### `messages`
    64	
    65	| Column | Type | Notes |
    66	|---|---|---|
    67	| id | uuid PK | |
    68	| connected_account_id | uuid | FK → connected_accounts ON DELETE CASCADE |
    69	| user_id | uuid | Denormalized for cached RLS subselect |
    70	| gmail_message_id | text | |
    71	| thread_id | text | |
    72	| from_address | text | |
    73	| to_addresses | text | |
    74	| subject | text | |
    75	| snippet | text | |
    76	| internal_date | timestamptz | |
    77	| body_text | text | |
    78	| body_html | text | |
    79	| label_ids | text[] | |
    80	| fetched_at | timestamptz | |
    81	| | UNIQUE | `(connected_account_id, gmail_message_id)` |
    82	| | INDEX | `(user_id, connected_account_id, internal_date DESC)` |
    83	
    84	RLS: authenticated users can SELECT their own rows only. No browser writes. The collector edge function writes via service role.
    85	
    86	### Token storage
    87	
    88	OAuth refresh tokens are stored in Supabase Vault (or a service-role-only table with no authenticated RLS SELECT policy). They are never returned to the browser, never logged, never committed to git.
    89	
    90	## 5. Architecture
    91	
    92	### OAuth flow
    93	
    94	```
    95	Browser                    Edge Function                    Google OAuth
    96	   |                            |                               |
    97	   |-- GET /connect-google ---→ |                               |
    98	   |                            |-- build state (HMAC-signed) →|
    99	   |← redirect to Google ------||                               |
   100	   |                            |                               |
   101	   |-- user grants consent ----→→→→→→→→→→→→→→→→→→→→→→→→→→→→→|
   102	   |                            |← code + state ---------------||
   103	   |                            |-- validate state             |
   104	   |                            |-- exchange code for tokens --→|
   105	   |                            |← refresh + access tokens ----||
   106	   |                            |-- store refresh token in Vault
   107	   |                            |-- store connected_account record
   108	   |← redirect to /accounts ---||
   109	```
   110	
   111	The OAuth redirect URI is a **deployed** Supabase Edge Function: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/google-oauth-callback`. Authorized JavaScript origins: `http://localhost:5173` and the Netlify production URL. Google allows no wildcard subdomains — Netlify preview URLs will not work for OAuth.
   112	
   113	### Collector flow
   114	
   115	```
   116	Supabase Cron (pg_cron + pg_net)
   117	   |
   118	   |-- HTTP POST every N minutes → gmail-collector edge function
   119	                                        |
   120	                                        |-- read connected accounts (service role)
   121	                                        |-- for each account:
   122	                                        |     fetch refresh token from Vault
   123	                                        |     exchange for access token
   124	                                        |     fetch new messages (incremental, historyId cursor)
   125	                                        |     decode base64url body parts
   126	                                        |     upsert into messages (service role)
   127	                                        |     update sync_cursor + last_synced_at
   128	```
   129	
   130	Cron invocation keys are read from Supabase Vault — never inline in SQL.
   131	
   132	## 6. Google OAuth notes
   133	
   134	- Scope: `gmail.readonly` only. No send or modify scopes.
   135	- Publishing status: Testing. Add team demo accounts as test users.
   136	- Production reality (document, do not build): `gmail.readonly` is a restricted scope requiring annual CASA security assessment for external users. Realistic production path for Workspace clients is a domain-wide internal install, which avoids consumer verification.
   137	
   138	## 7. Scope
   139	
   140	**In scope:** Supabase Auth login, connect Google account OAuth flow, scheduled collector, two-pane email viewer, Netlify deployment.
   141	
   142	**Out of scope (future work):** Google Drive, Slack, Calendar, any non-email source, vector store/search/chat, any send/write/modify scope, production verification for external users, realtime subscriptions (React Query polling is sufficient).
   143	
   144	## 8. Deployment
   145	
   146	- Frontend: Netlify (Vite build, `dist/` output)
   147	- Backend: Supabase (hosted PostgreSQL + Edge Functions)
   148	- Edge Functions deployed with `supabase functions deploy`
   149	- Integration branch: `test`. Release branch: `main`. Feature PRs target `test`.
   150	
   151	## 9. Mandatory safety rules
   152	
   153	These rules are non-negotiable. Both Codex reviews explicitly check them.
   154	
   155	**Rule 1 — Tokens are server-side only.**
   156	OAuth refresh and access tokens are stored encrypted in Supabase Vault or a table with no `authenticated` RLS SELECT policy. They are never returned to the browser, never selectable through any service, never logged, and never committed to git. Only edge functions under the service role may read them.
   157	
   158	**Rule 2 — The browser is read-only on collected mail.**
   159	There are no INSERT, UPDATE, or DELETE RLS policies for `authenticated` on the `messages` table. The collector edge function writes via the service role only.
   160	
   161	**Rule 3 — Collected email is sensitive PII.**
   162	This week is collection and storage only. Email content must not be sent to any third-party service or external AI model. Keep it inside Supabase.
   163	
   164	**Rule 4 — Secrets never enter git.**
   165	`.gitignore` excludes `.env`, `.env.*`, and `.claude/settings.local.json`. Edge function secrets are stored in Supabase Vault and accessed via `Deno.env.get()` — never hardcoded.
   166	
   167	**Rule 5 — Collected content is untrusted input.**
   168	Before any future step feeds collected email to a tool-calling agent or LLM, prompt injection shielding is required. This is out of scope this week, but the architecture must not assume email body content is safe.
   169	
   170	## 10. Development workflow

exec
/bin/zsh -lc "nl -ba docs/dev-rules.md | sed -n '145,176p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
   145	git add <specific-files>   # Never: git add -A or git add .
   146	git commit -m "feat(scope): description"
   147	```
   148	
   149	If you add a migration:
   150	
   151	```bash
   152	# 1. Create via CLI — never manually
   153	npx supabase migration new your_description_here
   154	
   155	# 2. Edit the generated file in supabase/migrations/
   156	# 3. Test in a transaction
   157	npm run db:psql
   158	# psql> BEGIN;
   159	# psql> \i supabase/migrations/<timestamp>_your_description.sql
   160	# psql> ROLLBACK;
   161	
   162	# 4. Apply to cloud DB
   163	npx supabase db push --linked
   164	
   165	# 5. Verify it appears in Remote column
   166	npx supabase migration list --linked
   167	
   168	# 6. Regenerate TypeScript types
   169	npm run gen:types
   170	
   171	# 7. Commit both
   172	git add supabase/migrations/ src/types/database.types.ts
   173	git commit -m "feat(scope): add migration + regen types"
   174	```
   175	
   176	**Smoke test after each sub-issue:**

exec
/bin/zsh -lc "nl -ba .gitignore | sed -n '1,120p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	# Dependencies
     2	node_modules/
     3	dist/
     4	.cache/
     5	
     6	# Environment and secrets — NEVER commit these
     7	.env
     8	.env.*
     9	!.env.example
    10	
    11	# Claude Code local settings — personal, machine-specific
    12	.claude/settings.local.json
    13	
    14	# Claude memory — local only, never committed
    15	memory/
    16	
    17	# Supabase local artifacts
    18	supabase/.temp/
    19	supabase/.branches/
    20	
    21	# OS and editor noise
    22	.DS_Store
    23	Thumbs.db
    24	*.swp
    25	*.swo
    26	.idea/
    27	.vscode/settings.json
    28	
    29	# Build artifacts
    30	*.tsbuildinfo
    31	coverage/

exec
/bin/zsh -lc "nl -ba docs/dev-rules.md | sed -n '345,360p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
   345	---
   346	
   347	### ⛔ Migration Deploy Gate (MANDATORY)
   348	
   349	**Why this rule exists:** In May 2026, 47 migrations silently piled up over 3 months. Migration files were merged into `test` and `main` without ever being applied to the shared Supabase DB. The Supabase Preview CI check only validates against an ephemeral preview DB — it does NOT update the shared production DB. The fix took hours.
   350	
   351	**The rule:** Any PR that adds or modifies files under `supabase/migrations/` **must** have those migrations applied to the linked DB before the PR is opened. This is a precondition, not a post-merge step.
   352	
   353	**Verification command — must run before opening any PR:**
   354	
   355	```bash
   356	npx supabase migration list --linked
   357	# Every migration added in this branch must appear in BOTH Local and Remote columns.
   358	# If any row shows Local only (no Remote timestamp), STOP — apply it first.
   359	```
   360	

exec
/bin/zsh -lc "nl -ba supabase/migrations/20260617000003_cron_collector.sql | sed -n '1,80p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	-- Schedule gmail-collector to run every 5 minutes via pg_cron + pg_net
     2	DO $$
     3	BEGIN
     4	  PERFORM cron.unschedule('collect-gmail-every-5min');
     5	EXCEPTION WHEN others THEN
     6	  NULL;
     7	END $$;
     8	
     9	SELECT cron.schedule(
    10	  'collect-gmail-every-5min',
    11	  '*/5 * * * *',
    12	  $$
    13	  SELECT net.http_post(
    14	    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/gmail-collector',
    15	    headers := jsonb_build_object(
    16	      'Content-Type', 'application/json',
    17	      'Authorization', 'Bearer ' || (
    18	        SELECT decrypted_secret
    19	        FROM vault.decrypted_secrets
    20	        WHERE name = 'CRON_SECRET'
    21	        LIMIT 1
    22	      )
    23	    ),
    24	    body := '{}'::jsonb
    25	  );
    26	  $$
    27	);

exec
/bin/zsh -lc "nl -ba jest.config.ts | sed -n '1,120p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "nl -ba src/hooks/useMessages.ts | sed -n '1,80p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import { useQuery } from '@tanstack/react-query'
     2	import { getMessages } from '@/services/messages.service'
     3	
     4	export function useMessages() {
     5	  return useQuery({
     6	    queryKey: ['messages'],
     7	    queryFn: getMessages,
     8	    refetchInterval: 60_000,
     9	  })
    10	}

 succeeded in 0ms:
     1	import type { Config } from 'jest'
     2	
     3	const config: Config = {
     4	  preset: 'ts-jest',
     5	  testEnvironment: 'jsdom',
     6	  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
     7	  moduleNameMapper: {
     8	    '^@/(.*)$': '<rootDir>/src/$1',
     9	    '\\.(scss|css)$': '<rootDir>/src/test/__mocks__/styleMock.ts',
    10	  },
    11	  transform: {
    12	    '^.+\\.tsx?$': ['ts-jest', {
    13	      tsconfig: {
    14	        jsx: 'react-jsx',
    15	      },
    16	    }],
    17	  },
    18	  testMatch: ['**/__tests__/**/*.{ts,tsx}', '**/*.{spec,test}.{ts,tsx}'],
    19	  collectCoverageFrom: [
    20	    'src/**/*.{ts,tsx}',
    21	    '!src/main.tsx',
    22	    '!src/test/**',
    23	    '!src/types/**',
    24	  ],
    25	}
    26	
    27	export default config

exec
/bin/zsh -lc "nl -ba src/hooks/useMessage.ts | sed -n '1,80p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import { useQuery } from '@tanstack/react-query'
     2	import { getMessage } from '@/services/messages.service'
     3	
     4	export function useMessage(id: string | null) {
     5	  return useQuery({
     6	    queryKey: ['message', id],
     7	    queryFn: () => getMessage(id!),
     8	    enabled: !!id,
     9	  })
    10	}

exec
/bin/zsh -lc 'rg -n "gmail-collector|google-oauth|Deno|supabase/functions" .' in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
./src/services/accounts.service.ts:17:  const { data, error } = await supabase.functions.invoke<{ url: string }>('google-oauth-initiate')
./.env.example:14:# redirect URI: https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback
./.env.example:19:# Accessed in edge functions via Deno.env.get(). Never commit real values.
./docs/project-brief.md:29:Our todo-sample omits Edge Functions, but momentum uses them under `supabase/functions/`. This project needs them for the OAuth callback and the collector, so follow the momentum edge function pattern for those.
./docs/project-brief.md:45:- Redirect URI to register, the deployed edge function callback: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/google-oauth-callback`. Authorized JavaScript origins: `http://localhost:5173` and the Netlify production URL. Google allows no wildcard subdomains, so Netlify random preview URLs will not work for OAuth. Create the client ID and secret only after the exact redirect URI is set.
./supabase/functions/google-oauth-callback/index.ts:3:const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
./supabase/functions/google-oauth-callback/index.ts:52:Deno.serve(async (req: Request) => {
./supabase/functions/google-oauth-callback/index.ts:58:  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
./supabase/functions/google-oauth-callback/index.ts:59:  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
./supabase/functions/google-oauth-callback/index.ts:60:  const stateSecret = Deno.env.get('STATE_SECRET')!
./supabase/functions/google-oauth-callback/index.ts:61:  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
./supabase/functions/google-oauth-callback/index.ts:62:  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
./supabase/functions/google-oauth-callback/index.ts:63:  const siteUrl = Deno.env.get('SITE_URL') ?? 'http://localhost:5173'
./supabase/functions/google-oauth-initiate/index.ts:9:const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
./supabase/functions/google-oauth-initiate/index.ts:35:Deno.serve(async (req: Request) => {
./supabase/functions/google-oauth-initiate/index.ts:46:  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
./supabase/functions/google-oauth-initiate/index.ts:47:  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
./supabase/functions/google-oauth-initiate/index.ts:48:  const stateSecret = Deno.env.get('STATE_SECRET')!
./supabase/functions/google-oauth-initiate/index.ts:49:  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
./supabase/functions/gmail-collector/index.ts:100:Deno.serve(async (req: Request) => {
./supabase/functions/gmail-collector/index.ts:101:  const cronSecret = Deno.env.get('CRON_SECRET')!
./supabase/functions/gmail-collector/index.ts:107:  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
./supabase/functions/gmail-collector/index.ts:108:  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
./supabase/functions/gmail-collector/index.ts:109:  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
./supabase/functions/gmail-collector/index.ts:110:  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
./CLAUDE.md:33:7. **Secrets never enter git.** `.gitignore` excludes `.env`, `.env.*`, `.claude/settings.local.json`. Edge function secrets come from Supabase Vault via `Deno.env.get()` only.
./CLAUDE.md:76:  functions/        # Edge functions (google-oauth-callback, gmail-collector)
./README.md:35:**Edge functions:** Follow the momentum edge function pattern. This project uses them for the OAuth callback (`google-oauth-callback`) and the email collector (`gmail-collector`).
./README.md:69:| user_id | uuid | Denormalized for cached RLS subselect |
./README.md:111:The OAuth redirect URI is a **deployed** Supabase Edge Function: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/google-oauth-callback`. Authorized JavaScript origins: `http://localhost:5173` and the Netlify production URL. Google allows no wildcard subdomains — Netlify preview URLs will not work for OAuth.
./README.md:118:   |-- HTTP POST every N minutes → gmail-collector edge function
./README.md:165:`.gitignore` excludes `.env`, `.env.*`, and `.claude/settings.local.json`. Edge function secrets are stored in Supabase Vault and accessed via `Deno.env.get()` — never hardcoded.
./supabase/migrations/20260617000003_cron_collector.sql:1:-- Schedule gmail-collector to run every 5 minutes via pg_cron + pg_net
./supabase/migrations/20260617000003_cron_collector.sql:14:    url := 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/gmail-collector',
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:16:2. **File**: `supabase/functions/google-oauth-callback/index.ts:94-97`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:26:3. **File**: `supabase/functions/google-oauth-initiate/index.ts:18-21`, `supabase/functions/google-oauth-callback/index.ts:39-43`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:38:5. **File**: `supabase/functions/google-oauth-callback/index.ts:46-48`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:44:6. **File**: `supabase/functions/google-oauth-callback/index.ts:122-129`, `:153-169`; `supabase/functions/gmail-collector/index.ts:130-134`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:50:7. **File**: `supabase/functions/gmail-collector/index.ts:154-165`, `:211-218`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:56:8. **File**: `supabase/functions/gmail-collector/index.ts:167-171`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:73:10. **File**: `supabase/functions/gmail-collector/index.ts:113-116`, `:182-203`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:79:11. **File**: `supabase/functions/gmail-collector/index.ts:26-29`, `:38-51`  
./docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md:103:Files needing most attention: `supabase/functions/google-oauth-callback/index.ts`, `supabase/functions/gmail-collector/index.ts`, `src/components/email/MessageDetail.tsx`, `supabase/migrations/20260617000001_initial_schema.sql`.
./package-lock.json:2654:    "node_modules/@supabase/functions-js": {
./package-lock.json:2656:      "resolved": "https://registry.npmjs.org/@supabase/functions-js/-/functions-js-2.108.2.tgz",
./package-lock.json:2717:        "@supabase/functions-js": "2.108.2",

codex
There is also a prior Codex review artifact in `docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md`. I’m checking it because the plan claims it closes “Phase A” gaps, and any unaddressed critical/importants are part of completeness.
exec
/bin/zsh -lc "nl -ba docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md | sed -n '1,130p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	# Codex Code Review — Gmail MVP
     2	
     3	**Date:** 2026-06-18
     4	**Model:** gpt-5.5 (ChatGPT auth — o3/o4-mini not available on this account)
     5	
     6	---
     7	
     8	**Findings**
     9	
    10	1. **File**: `src/components/email/MessageDetail.tsx:41-44`  
    11	   **Category**: security  
    12	   **Severity**: critical  
    13	   **Finding**: Raw collected email HTML is rendered with `srcDoc={message.body_html}` and `sandbox="allow-same-origin"`. Even without scripts, remote images/CSS/fonts in email HTML can make third-party network requests, leaking viewing activity and tracking identifiers. This violates the PII containment rule.  
    14	   **Fix**: Sanitize/rewrite HTML before rendering. Block remote loads with an injected CSP such as `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`; remove `allow-same-origin` unless strictly required.
    15	
    16	2. **File**: `supabase/functions/google-oauth-callback/index.ts:94-97`  
    17	   **Category**: security  
    18	   **Severity**: critical  
    19	   **Finding**: Raw OAuth token endpoint response bodies are logged: `console.error('Token exchange failed:', tokenRes.status, body)`. OAuth/token responses must be treated as sensitive; this creates a token/secret logging path.  
    20	   **Fix**: Never log token endpoint bodies. Log only sanitized metadata:
    21	   ```ts
    22	   const err = await tokenRes.json().catch(() => ({}))
    23	   console.error('Token exchange failed', { status: tokenRes.status, error: err.error })
    24	   ```
    25	
    26	3. **File**: `supabase/functions/google-oauth-initiate/index.ts:18-21`, `supabase/functions/google-oauth-callback/index.ts:39-43`  
    27	   **Category**: security  
    28	   **Severity**: critical  
    29	   **Finding**: OAuth `nonce` is generated but never stored or checked. Callback verifies signature/expiry only, so a captured state can be replayed during its 5-minute window.  
    30	   **Fix**: Store nonce server-side with `user_id` and expiry, then validate and delete it atomically in callback before token exchange.
    31	
    32	4. **File**: `supabase/migrations/20260617000001_initial_schema.sql:40-44`, `:67-71`  
    33	   **Category**: database  
    34	   **Severity**: bug  
    35	   **Finding**: `messages.user_id` drives RLS, but the DB does not enforce that it matches `connected_accounts.user_id`. A bad service-role write could attach user B’s account/message to user A’s `user_id`, and RLS would expose it.  
    36	   **Fix**: Add an invariant, e.g. unique `(id, user_id)` on `connected_accounts` plus composite FK from `messages(connected_account_id, user_id)`, or a trigger that derives `messages.user_id` from the account.
    37	
    38	5. **File**: `supabase/functions/google-oauth-callback/index.ts:46-48`  
    39	   **Category**: security  
    40	   **Severity**: bug  
    41	   **Finding**: `id_token` is decoded without verifying signature, issuer, audience, expiry, or `email_verified`: `JSON.parse(base64urlDecode(idToken.split('.')[1]))`.  
    42	   **Fix**: Verify Google JWT claims using Google JWKS or call Google’s tokeninfo/userinfo endpoint, and require `aud === GOOGLE_CLIENT_ID`, valid `iss`, unexpired `exp`, and `email_verified`.
    43	
    44	6. **File**: `supabase/functions/google-oauth-callback/index.ts:122-129`, `:153-169`; `supabase/functions/gmail-collector/index.ts:130-134`  
    45	   **Category**: correctness  
    46	   **Severity**: bug  
    47	   **Finding**: Account is saved as `status: 'active'` before the refresh token is stored. If Vault write fails, the collector later logs “No vault secret” and leaves the account active forever.  
    48	   **Fix**: Insert/upsert as `pending` or `error` until Vault succeeds, then mark `active`. In collector, missing Vault secret should mark the account `error`.
    49	
    50	7. **File**: `supabase/functions/gmail-collector/index.ts:154-165`, `:211-218`  
    51	   **Category**: correctness  
    52	   **Severity**: bug  
    53	   **Finding**: First sync expects `messages.list` to return `historyId`: `newCursor = data.historyId ?? null`. Gmail `messages.list` does not provide a mailbox cursor, so `sync_cursor` stays null and first sync repeats every run.  
    54	   **Fix**: After first sync, call `users.getProfile` and store `historyId`, or fetch full messages and store the max message `historyId`.
    55	
    56	8. **File**: `supabase/functions/gmail-collector/index.ts:167-171`  
    57	   **Category**: correctness  
    58	   **Severity**: bug  
    59	   **Finding**: Expired/invalid Gmail history cursors are not handled. Any non-OK history response just increments `errors` and keeps the stale cursor.  
    60	   **Fix**: Detect 404/history-too-old responses, reset cursor, perform a bounded full resync, and store a fresh profile `historyId`.
    61	
    62	9. **File**: `src/services/messages.service.ts:8-10`, `:18-19`  
    63	   **Category**: performance  
    64	   **Severity**: bug  
    65	   **Finding**: Browser list query does `.select('*')` with no limit, returning every full email body to render the list. This is unbounded and unnecessarily expands the PII surface.  
    66	   **Fix**: List query should select only metadata and paginate:
    67	   ```ts
    68	   .select('id,from_address,subject,snippet,internal_date')
    69	   .order('internal_date', { ascending: false })
    70	   .range(0, 99)
    71	   ```
    72	
    73	10. **File**: `supabase/functions/gmail-collector/index.ts:113-116`, `:182-203`  
    74	    **Category**: performance  
    75	    **Severity**: improvement  
    76	    **Finding**: Collector fetches all active accounts without a batch limit, then does per-message Gmail fetches and per-message DB upserts sequentially. This will time out or hit rate limits as accounts grow.  
    77	    **Fix**: Batch accounts, add a lease/claim mechanism, use bounded concurrency, and bulk upsert collected messages per account.
    78	
    79	11. **File**: `supabase/functions/gmail-collector/index.ts:26-29`, `:38-51`  
    80	    **Category**: correctness  
    81	    **Severity**: bug  
    82	    **Finding**: `base64urlDecode` returns `atob(padded)`, a binary string, not UTF-8 decoded text. Non-ASCII email bodies will corrupt.  
    83	    **Fix**: Decode to bytes and run `new TextDecoder('utf-8').decode(bytes)`, with charset fallback if needed.
    84	
    85	12. **File**: `src/components/auth/LoginPage.tsx:12-15`; `package.json:20-24`  
    86	    **Category**: correctness  
    87	    **Severity**: bug  
    88	    **Finding**: The plan says React 18, React Router v6, Vite frontend, and email/password Supabase Auth. This implements Google Supabase OAuth login and uses React 19 / Router 7 / Vite 8.  
    89	    **Fix**: Align implementation with the accepted stack and auth flow, or update the spec and tests explicitly.
    90	
    91	**Mandatory Safety Check**
    92	
    93	- Tokens server-side only: mostly followed, but raw OAuth token response logging is a critical violation risk.
    94	- Browser read-only on `messages`: migration only creates SELECT policy for `authenticated`; no INSERT/UPDATE/DELETE policy found.
    95	- PII containment: violated by raw email HTML rendering that can load third-party resources.
    96	- Secrets out of git: `.env.example` uses placeholders; no real secret found in reviewed files.
    97	- Untrusted content: raw `body_html` reaches `iframe srcDoc`; needs sanitization and network blocking.
    98	
    99	Overall code quality score: **4/10**
   100	
   101	Top 3 highest-risk areas: OAuth callback/state handling, raw email HTML rendering, collector cursor/error handling.
   102	
   103	Files needing most attention: `supabase/functions/google-oauth-callback/index.ts`, `supabase/functions/gmail-collector/index.ts`, `src/components/email/MessageDetail.tsx`, `supabase/migrations/20260617000001_initial_schema.sql`.
   104	
   105	Verdict: **needs significant rework before shipping**.
   106	tokens use
exec
/bin/zsh -lc "nl -ba supabase/functions/google-oauth-initiate/index.ts | sed -n '1,110p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
     2	
     3	const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
     4	const SCOPES = [
     5	  'openid',
     6	  'email',
     7	  'https://www.googleapis.com/auth/gmail.readonly',
     8	].join(' ')
     9	const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
    10	
    11	function base64url(data: ArrayBuffer): string {
    12	  return btoa(String.fromCharCode(...new Uint8Array(data)))
    13	    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    14	}
    15	
    16	async function buildStateJwt(userId: string, stateSecret: string): Promise<string> {
    17	  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
    18	  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    19	    user_id: userId,
    20	    nonce: crypto.randomUUID(),
    21	    exp: Math.floor(Date.now() / 1000) + 300,
    22	  })))
    23	  const signingInput = `${header}.${payload}`
    24	  const key = await crypto.subtle.importKey(
    25	    'raw',
    26	    new TextEncoder().encode(stateSecret),
    27	    { name: 'HMAC', hash: 'SHA-256' },
    28	    false,
    29	    ['sign'],
    30	  )
    31	  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
    32	  return `${signingInput}.${base64url(sig)}`
    33	}
    34	
    35	Deno.serve(async (req: Request) => {
    36	  const corsHeaders = {
    37	    'Access-Control-Allow-Origin': '*',
    38	    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    39	    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    40	  }
    41	
    42	  if (req.method === 'OPTIONS') {
    43	    return new Response(null, { headers: corsHeaders })
    44	  }
    45	
    46	  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    47	  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    48	  const stateSecret = Deno.env.get('STATE_SECRET')!
    49	  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
    50	
    51	  const authHeader = req.headers.get('Authorization')
    52	  if (!authHeader) {
    53	    return Response.json({ error: 'Unauthorized' }, { status: 401 })
    54	  }
    55	
    56	  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    57	    global: { headers: { Authorization: authHeader } },
    58	  })
    59	
    60	  const { data: { user }, error: userError } = await supabase.auth.getUser()
    61	  if (userError || !user) {
    62	    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    63	  }
    64	
    65	  const state = await buildStateJwt(user.id, stateSecret)
    66	
    67	  const params = new URLSearchParams({
    68	    client_id: clientId,
    69	    redirect_uri: REDIRECT_URI,
    70	    response_type: 'code',
    71	    scope: SCOPES,
    72	    access_type: 'offline',
    73	    prompt: 'consent',
    74	    state,
    75	  })
    76	
    77	  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`
    78	  return Response.json({ url }, { headers: corsHeaders })
    79	})

exec
/bin/zsh -lc "nl -ba src/components/email/MessageDetail.tsx | sed -n '1,90p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import type { Message } from '@/services/messages.service'
     2	import styles from './MessageDetail.module.scss'
     3	
     4	interface Props {
     5	  message: Message | null | undefined
     6	  isLoading: boolean
     7	}
     8	
     9	function wrapWithCsp(html: string): string {
    10	  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
    11	  return `<!DOCTYPE html><html><head>${csp}</head><body>${html}</body></html>`
    12	}
    13	
    14	function formatFullDate(dateStr: string | null): string {
    15	  if (!dateStr) return ''
    16	  return new Date(dateStr).toLocaleString([], {
    17	    weekday: 'short',
    18	    year: 'numeric',
    19	    month: 'short',
    20	    day: 'numeric',
    21	    hour: '2-digit',
    22	    minute: '2-digit',
    23	  })
    24	}
    25	
    26	export default function MessageDetail({ message, isLoading }: Props) {
    27	  if (isLoading) {
    28	    return <div className={styles.empty}>Loading…</div>
    29	  }
    30	
    31	  if (!message) {
    32	    return <div className={styles.empty}>Select a message to read it.</div>
    33	  }
    34	
    35	  return (
    36	    <div className={styles.detail}>
    37	      <div className={styles.header}>
    38	        <h2 className={styles.subject}>{message.subject || '(no subject)'}</h2>
    39	        <div className={styles.meta}>
    40	          <span><strong>From:</strong> {message.from_address}</span>
    41	          <span><strong>To:</strong> {message.to_addresses}</span>
    42	          <span><strong>Date:</strong> {formatFullDate(message.internal_date)}</span>
    43	        </div>
    44	      </div>
    45	      <div className={styles.body}>
    46	        {message.body_html ? (
    47	          <iframe
    48	            srcDoc={wrapWithCsp(message.body_html)}
    49	            sandbox=""
    50	            className={styles.iframe}
    51	            title={message.subject ?? 'Email content'}
    52	          />
    53	        ) : message.body_text ? (
    54	          <pre className={styles.text}>{message.body_text}</pre>
    55	        ) : (
    56	          <p className={styles.noContent}>No content available for this message.</p>
    57	        )}
    58	      </div>
    59	    </div>
    60	  )
    61	}

exec
/bin/zsh -lc "nl -ba docs/superpowers/plans/2026-06-18-gmail-mvp-codex-code-review.md | sed -n '8,48p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
exec
/bin/zsh -lc "nl -ba supabase/functions/google-oauth-callback/index.ts | sed -n '1,190p'" in /Users/caleb/Documents/Claude Code/gmail-knowledge-collector
 succeeded in 0ms:
     1	import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
     2	
     3	const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
     4	const TOKEN_URL = 'https://oauth2.googleapis.com/token'
     5	
     6	function base64url(data: ArrayBuffer): string {
     7	  return btoa(String.fromCharCode(...new Uint8Array(data)))
     8	    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
     9	}
    10	
    11	function base64urlDecode(str: string): string {
    12	  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
    13	  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    14	  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
    15	  return new TextDecoder('utf-8').decode(bytes)
    16	}
    17	
    18	interface StatePayload {
    19	  user_id: string
    20	  nonce: string
    21	  exp: number
    22	}
    23	
    24	async function verifyStateJwt(token: string, secret: string): Promise<StatePayload> {
    25	  const parts = token.split('.')
    26	  if (parts.length !== 3) throw new Error('Invalid state token')
    27	  const [header, payload, signature] = parts
    28	  const signingInput = `${header}.${payload}`
    29	  const key = await crypto.subtle.importKey(
    30	    'raw',
    31	    new TextEncoder().encode(secret),
    32	    { name: 'HMAC', hash: 'SHA-256' },
    33	    false,
    34	    ['verify'],
    35	  )
    36	  const sigBytes = Uint8Array.from(
    37	    atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
    38	    (c) => c.charCodeAt(0),
    39	  )
    40	  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(signingInput))
    41	  if (!valid) throw new Error('Invalid signature')
    42	  const data: StatePayload = JSON.parse(base64urlDecode(payload))
    43	  if (data.exp < Math.floor(Date.now() / 1000)) throw new Error('State token expired')
    44	  return data
    45	}
    46	
    47	function extractEmailFromIdToken(idToken: string): string {
    48	  const payload = JSON.parse(base64urlDecode(idToken.split('.')[1]))
    49	  return payload.email as string
    50	}
    51	
    52	Deno.serve(async (req: Request) => {
    53	  const url = new URL(req.url)
    54	  const code = url.searchParams.get('code')
    55	  const state = url.searchParams.get('state')
    56	  const errorParam = url.searchParams.get('error')
    57	
    58	  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    59	  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    60	  const stateSecret = Deno.env.get('STATE_SECRET')!
    61	  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
    62	  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
    63	  const siteUrl = Deno.env.get('SITE_URL') ?? 'http://localhost:5173'
    64	
    65	  if (errorParam || !code || !state) {
    66	    return Response.redirect(`${siteUrl}/accounts?error=oauth_denied`, 302)
    67	  }
    68	
    69	  let statePayload: StatePayload
    70	  try {
    71	    statePayload = await verifyStateJwt(state, stateSecret)
    72	  } catch (e) {
    73	    console.error('State verification failed:', e)
    74	    return new Response('Invalid or expired state. Please try again.', { status: 400 })
    75	  }
    76	
    77	  let tokenRes: Response
    78	  try {
    79	    tokenRes = await fetch(TOKEN_URL, {
    80	      method: 'POST',
    81	      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    82	      body: new URLSearchParams({
    83	        code,
    84	        client_id: clientId,
    85	        client_secret: clientSecret,
    86	        redirect_uri: REDIRECT_URI,
    87	        grant_type: 'authorization_code',
    88	      }),
    89	    })
    90	  } catch (e) {
    91	    console.error('Token exchange fetch failed:', e)
    92	    return new Response('Token exchange network error', { status: 502 })
    93	  }
    94	
    95	  if (!tokenRes.ok) {
    96	    const err = await tokenRes.json().catch(() => ({})) as { error?: string }
    97	    console.error('Token exchange failed', { status: tokenRes.status, error: err.error })
    98	    return new Response('Token exchange failed', { status: 502 })
    99	  }
   100	
   101	  const tokens = await tokenRes.json() as {
   102	    refresh_token?: string
   103	    access_token: string
   104	    id_token: string
   105	  }
   106	
   107	  if (!tokens.refresh_token) {
   108	    console.error('No refresh_token in response. Tokens keys:', Object.keys(tokens))
   109	    return new Response('No refresh token returned. Revoke access at myaccount.google.com/permissions and try again.', { status: 400 })
   110	  }
   111	
   112	  let emailAddress: string
   113	  try {
   114	    emailAddress = extractEmailFromIdToken(tokens.id_token)
   115	  } catch (e) {
   116	    console.error('Failed to extract email from id_token:', e)
   117	    return new Response('Failed to read account email', { status: 500 })
   118	  }
   119	
   120	  const userId = statePayload.user_id
   121	  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
   122	
   123	  // Save account as 'error' first; update to 'active' only after vault write succeeds
   124	  const { data: account, error: upsertError } = await supabaseAdmin
   125	    .from('connected_accounts')
   126	    .upsert({
   127	      user_id: userId,
   128	      provider: 'google',
   129	      email_address: emailAddress,
   130	      status: 'error',
   131	      granted_scopes: 'openid email https://www.googleapis.com/auth/gmail.readonly',
   132	      updated_at: new Date().toISOString(),
   133	    }, {
   134	      onConflict: 'user_id,email_address',
   135	      ignoreDuplicates: false,
   136	    })
   137	    .select('id')
   138	    .single()
   139	
   140	  if (upsertError || !account) {
   141	    console.error('Upsert error:', JSON.stringify(upsertError))
   142	    return new Response('Failed to save account', { status: 500 })
   143	  }
   144	
   145	  // Store refresh token in Vault keyed by account id
   146	  const { data: existingSecretId, error: vaultLookupError } = await supabaseAdmin
   147	    .rpc('get_vault_secret_id', { secret_name: account.id })
   148	
   149	  if (vaultLookupError) {
   150	    console.error('Vault lookup error:', JSON.stringify(vaultLookupError))
   151	    return new Response('Failed to access vault', { status: 500 })
   152	  }
   153	
   154	  if (existingSecretId) {
   155	    const { error: updateErr } = await supabaseAdmin.rpc('vault_update_secret', {
   156	      secret_id: existingSecretId,
   157	      new_secret: tokens.refresh_token,
   158	    })
   159	    if (updateErr) {
   160	      console.error('Vault update error:', JSON.stringify(updateErr))
   161	      return new Response('Failed to update vault secret', { status: 500 })
   162	    }
   163	  } else {
   164	    const { error: createErr } = await supabaseAdmin.rpc('vault_create_secret', {
   165	      secret: tokens.refresh_token,
   166	      name: account.id,
   167	      description: `OAuth refresh token for ${emailAddress}`,
   168	    })
   169	    if (createErr) {
   170	      console.error('Vault create error:', JSON.stringify(createErr))
   171	      return new Response('Failed to store vault secret', { status: 500 })
   172	    }
   173	  }
   174	
   175	  // Vault write succeeded — mark account active
   176	  await supabaseAdmin
   177	    .from('connected_accounts')
   178	    .update({ status: 'active', updated_at: new Date().toISOString() })
   179	    .eq('id', account.id)
   180	
   181	  // access_token is ephemeral — never stored
   182	  return Response.redirect(`${siteUrl}/accounts`, 302)
   183	})

 succeeded in 0ms:
     8	**Findings**
     9	
    10	1. **File**: `src/components/email/MessageDetail.tsx:41-44`  
    11	   **Category**: security  
    12	   **Severity**: critical  
    13	   **Finding**: Raw collected email HTML is rendered with `srcDoc={message.body_html}` and `sandbox="allow-same-origin"`. Even without scripts, remote images/CSS/fonts in email HTML can make third-party network requests, leaking viewing activity and tracking identifiers. This violates the PII containment rule.  
    14	   **Fix**: Sanitize/rewrite HTML before rendering. Block remote loads with an injected CSP such as `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`; remove `allow-same-origin` unless strictly required.
    15	
    16	2. **File**: `supabase/functions/google-oauth-callback/index.ts:94-97`  
    17	   **Category**: security  
    18	   **Severity**: critical  
    19	   **Finding**: Raw OAuth token endpoint response bodies are logged: `console.error('Token exchange failed:', tokenRes.status, body)`. OAuth/token responses must be treated as sensitive; this creates a token/secret logging path.  
    20	   **Fix**: Never log token endpoint bodies. Log only sanitized metadata:
    21	   ```ts
    22	   const err = await tokenRes.json().catch(() => ({}))
    23	   console.error('Token exchange failed', { status: tokenRes.status, error: err.error })
    24	   ```
    25	
    26	3. **File**: `supabase/functions/google-oauth-initiate/index.ts:18-21`, `supabase/functions/google-oauth-callback/index.ts:39-43`  
    27	   **Category**: security  
    28	   **Severity**: critical  
    29	   **Finding**: OAuth `nonce` is generated but never stored or checked. Callback verifies signature/expiry only, so a captured state can be replayed during its 5-minute window.  
    30	   **Fix**: Store nonce server-side with `user_id` and expiry, then validate and delete it atomically in callback before token exchange.
    31	
    32	4. **File**: `supabase/migrations/20260617000001_initial_schema.sql:40-44`, `:67-71`  
    33	   **Category**: database  
    34	   **Severity**: bug  
    35	   **Finding**: `messages.user_id` drives RLS, but the DB does not enforce that it matches `connected_accounts.user_id`. A bad service-role write could attach user B’s account/message to user A’s `user_id`, and RLS would expose it.  
    36	   **Fix**: Add an invariant, e.g. unique `(id, user_id)` on `connected_accounts` plus composite FK from `messages(connected_account_id, user_id)`, or a trigger that derives `messages.user_id` from the account.
    37	
    38	5. **File**: `supabase/functions/google-oauth-callback/index.ts:46-48`  
    39	   **Category**: security  
    40	   **Severity**: bug  
    41	   **Finding**: `id_token` is decoded without verifying signature, issuer, audience, expiry, or `email_verified`: `JSON.parse(base64urlDecode(idToken.split('.')[1]))`.  
    42	   **Fix**: Verify Google JWT claims using Google JWKS or call Google’s tokeninfo/userinfo endpoint, and require `aud === GOOGLE_CLIENT_ID`, valid `iss`, unexpired `exp`, and `email_verified`.
    43	
    44	6. **File**: `supabase/functions/google-oauth-callback/index.ts:122-129`, `:153-169`; `supabase/functions/gmail-collector/index.ts:130-134`  
    45	   **Category**: correctness  
    46	   **Severity**: bug  
    47	   **Finding**: Account is saved as `status: 'active'` before the refresh token is stored. If Vault write fails, the collector later logs “No vault secret” and leaves the account active forever.  
    48	   **Fix**: Insert/upsert as `pending` or `error` until Vault succeeds, then mark `active`. In collector, missing Vault secret should mark the account `error`.

codex
**Findings**

1. **Category**: completeness  
   **Severity**: critical  
   **Finding**: EU-14’s 12-month backfill can still skip mail. It says to set `sync_cursor` from `users/me/profile` only on the final page, but messages arriving during a multi-run backfill can fall before that final cursor and never be replayed by History API. Current collector cursor updates happen at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:227>).  
   **Recommendation**: Capture and persist a `backfill_start_history_id` before the first page, then after backfill completes set `sync_cursor` to that starting history ID so incremental sync replays changes during backfill.

2. **Category**: completeness  
   **Severity**: important  
   **Finding**: EU-14 collects 12 months, but the viewer still only fetches the latest 200 rows via `.range(0, 199)` in [messages.service.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/services/messages.service.ts:7>). The plan does not add pagination, “load more,” or search, so most backfilled email is not reachable in the browser.  
   **Recommendation**: Add explicit list pagination parameters to `getMessages()`, `useMessages`, and `EmailPage`, or narrow the demo claim to background collection only.

3. **Category**: database  
   **Severity**: critical  
   **Finding**: The plan does not address the RLS integrity gap between `messages.user_id` and `connected_accounts.user_id`. RLS depends on `messages.user_id` at [initial_schema.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/migrations/20260617000001_initial_schema.sql:67>), but the DB does not enforce that it matches the owning connected account. A bad service-role write can expose another user’s message.  
   **Recommendation**: Add an idempotent migration with either a composite FK from `messages(connected_account_id, user_id)` to `connected_accounts(id, user_id)` plus a supporting unique constraint, or a trigger that derives `messages.user_id`.

4. **Category**: database  
   **Severity**: important  
   **Finding**: EU-14 names only `20260618000001_backfill_columns.sql`. It omits the required paired update to [database.types.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/types/database.types.ts:17>), which currently has no `backfill_complete` or `backfill_page_token`. This violates the repo rule in README lines 37-39 and CLAUDE’s type-generation invariant.  
   **Recommendation**: Add `src/types/database.types.ts` to EU-14 deliverables and acceptance criteria after `npm run gen:types`.

5. **Category**: ordering  
   **Severity**: important  
   **Finding**: EU-14 has no deployment order. If `gmail-collector` is deployed before the migration is applied, selecting `backfill_complete` / `backfill_page_token` from `connected_accounts` will fail. The current query is at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:114>).  
   **Recommendation**: Specify order: create migration, push linked DB, regenerate types, update collector, deploy `gmail-collector`, then verify cron logs.

6. **Category**: testing  
   **Severity**: critical  
   **Finding**: “Unit test for the backfill branch” is underspecified and likely not runnable as written. Jest is configured for `src/**/*` coverage and jsdom in [jest.config.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/jest.config.ts:18>), while the collector is a Deno Edge Function under `supabase/functions`.  
   **Recommendation**: Extract testable collector logic into pure functions or add a Deno test script. Cover: page token present/absent, partial message fetch failure, Gmail list failure, profile failure, repeated run with stored token, and no cursor advance on failed page processing.

7. **Category**: security  
   **Severity**: critical  
   **Finding**: The plan says token handling is unchanged, but unresolved OAuth safety gaps remain. `nonce` is generated in [google-oauth-initiate/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-initiate/index.ts:18>) and accepted in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-callback/index.ts:24>) without server-side one-time storage. `id_token` is decoded without signature/claim verification at [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-callback/index.ts:47>).  
   **Recommendation**: Add an OAuth hardening unit before demo readiness or explicitly record it as accepted risk. Prefer storing nonce with expiry and verifying/deleting it atomically; verify Google ID token claims or fetch userinfo.

8. **Category**: safety  
   **Severity**: important  
   **Finding**: EU-17 asks to document Supabase Vault secret creation, edge function secrets, Netlify env vars, and encourages screenshots in `docs/manual-process-journal.md`. That creates a direct path to committing secret values or sensitive dashboard screenshots, despite `.gitignore` protecting only `.env*` files at [.gitignore](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/.gitignore:6>).  
   **Recommendation**: Add explicit journal rules: names and purpose only, never values; redact/crop screenshots; no client secret, refresh token, service role key, `CRON_SECRET`, or Vault plaintext.

9. **Category**: performance  
   **Severity**: important  
   **Finding**: EU-14 says “200 messages per cron run,” but the current collector loads all active accounts and loops each account at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:114>) and [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:126>). In practice this becomes 200 messages per account per run, followed by sequential full-message fetches.  
   **Recommendation**: Correct the claim or add account batching/lease logic. Also prevent overlapping cron runs if a backfill takes longer than the 5-minute schedule in [20260617000003_cron_collector.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/migrations/20260617000003_cron_collector.sql:9>).

10. **Category**: completeness  
    **Severity**: important  
    **Finding**: EU-15 says to show an account email badge in `MessageItem`, but `MessageListItem` only contains message columns in [messages.service.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/services/messages.service.ts:5>), and `MessageItem` only receives the message object at [MessageItem.tsx](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/components/email/MessageItem.tsx:4>).  
    **Recommendation**: Specify the data path: either join `connected_accounts(email_address)` in `getMessages()` or build an `accountId -> email` map from `useAccounts()` in `EmailPage` and pass the label through `MessageList`.

11. **Category**: integration  
    **Severity**: important  
    **Finding**: EU-15 does not mention React Query cache keys. `useMessages` currently uses a fixed `['messages']` key at [useMessages.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/hooks/useMessages.ts:5>). Passing a filter without including it in the key risks stale “All accounts” data being reused for a filtered view.  
    **Recommendation**: Make the query key `['messages', connectedAccountId ?? 'all']`; reset `selectedId` and `showDetail` when the filter changes.

12. **Category**: testing  
    **Severity**: important  
    **Finding**: EU-15 tests cover only the happy filtered path. Missing negative cases: RLS prevents another user’s account filter from returning data, unknown account ID returns empty, filter change clears selected detail, and account label fallback when the account row is missing.  
    **Recommendation**: Add service tests for `.eq('connected_account_id', id)` and UI tests using two accounts/messages with filter changes.

13. **Category**: rollback  
    **Severity**: important  
    **Finding**: No rollback plan exists. EU-14 changes persistent sync state (`sync_cursor`, `backfill_complete`, `backfill_page_token`) and cron behavior; a bad deploy can mark accounts complete or advance page tokens incorrectly.  
    **Recommendation**: Add rollback steps: pause cron, redeploy previous `gmail-collector`, snapshot affected `connected_accounts`, clear bad `backfill_page_token`, and restore/choose safe `sync_cursor` values before resuming.

14. **Category**: safety  
    **Severity**: suggestion  
    **Finding**: The safety section lists all five mandatory rules, but they are not tied to acceptance checks. EU-19 explicitly says to “show HTML rendering,” while the untrusted-content safety check depends on the iframe CSP/sandbox in [MessageDetail.tsx](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/components/email/MessageDetail.tsx:9>).  
    **Recommendation**: Add acceptance checks confirming no browser writes to `messages`, no token values in logs/docs, no external email-content calls, and HTML remains sandboxed with remote loads blocked.

**Summary**

Overall plan quality: **5/10**.

Top 3 risks:
1. EU-14 can silently skip messages during multi-run backfill because it does not persist a starting history cursor.
2. Existing RLS integrity is incomplete because `messages.user_id` is not constrained to the connected account owner.
3. Backfill expands stored data, but the UI still exposes only the latest 200 messages and lacks pagination/search.

Verdict: **needs revision before implementation**. The plan is directionally useful, but EU-14 and the database/security gaps need tightening before this is safe to build for a demo branch.
tokens used
142,626
**Findings**

1. **Category**: completeness  
   **Severity**: critical  
   **Finding**: EU-14’s 12-month backfill can still skip mail. It says to set `sync_cursor` from `users/me/profile` only on the final page, but messages arriving during a multi-run backfill can fall before that final cursor and never be replayed by History API. Current collector cursor updates happen at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:227>).  
   **Recommendation**: Capture and persist a `backfill_start_history_id` before the first page, then after backfill completes set `sync_cursor` to that starting history ID so incremental sync replays changes during backfill.

2. **Category**: completeness  
   **Severity**: important  
   **Finding**: EU-14 collects 12 months, but the viewer still only fetches the latest 200 rows via `.range(0, 199)` in [messages.service.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/services/messages.service.ts:7>). The plan does not add pagination, “load more,” or search, so most backfilled email is not reachable in the browser.  
   **Recommendation**: Add explicit list pagination parameters to `getMessages()`, `useMessages`, and `EmailPage`, or narrow the demo claim to background collection only.

3. **Category**: database  
   **Severity**: critical  
   **Finding**: The plan does not address the RLS integrity gap between `messages.user_id` and `connected_accounts.user_id`. RLS depends on `messages.user_id` at [initial_schema.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/migrations/20260617000001_initial_schema.sql:67>), but the DB does not enforce that it matches the owning connected account. A bad service-role write can expose another user’s message.  
   **Recommendation**: Add an idempotent migration with either a composite FK from `messages(connected_account_id, user_id)` to `connected_accounts(id, user_id)` plus a supporting unique constraint, or a trigger that derives `messages.user_id`.

4. **Category**: database  
   **Severity**: important  
   **Finding**: EU-14 names only `20260618000001_backfill_columns.sql`. It omits the required paired update to [database.types.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/types/database.types.ts:17>), which currently has no `backfill_complete` or `backfill_page_token`. This violates the repo rule in README lines 37-39 and CLAUDE’s type-generation invariant.  
   **Recommendation**: Add `src/types/database.types.ts` to EU-14 deliverables and acceptance criteria after `npm run gen:types`.

5. **Category**: ordering  
   **Severity**: important  
   **Finding**: EU-14 has no deployment order. If `gmail-collector` is deployed before the migration is applied, selecting `backfill_complete` / `backfill_page_token` from `connected_accounts` will fail. The current query is at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:114>).  
   **Recommendation**: Specify order: create migration, push linked DB, regenerate types, update collector, deploy `gmail-collector`, then verify cron logs.

6. **Category**: testing  
   **Severity**: critical  
   **Finding**: “Unit test for the backfill branch” is underspecified and likely not runnable as written. Jest is configured for `src/**/*` coverage and jsdom in [jest.config.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/jest.config.ts:18>), while the collector is a Deno Edge Function under `supabase/functions`.  
   **Recommendation**: Extract testable collector logic into pure functions or add a Deno test script. Cover: page token present/absent, partial message fetch failure, Gmail list failure, profile failure, repeated run with stored token, and no cursor advance on failed page processing.

7. **Category**: security  
   **Severity**: critical  
   **Finding**: The plan says token handling is unchanged, but unresolved OAuth safety gaps remain. `nonce` is generated in [google-oauth-initiate/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-initiate/index.ts:18>) and accepted in [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-callback/index.ts:24>) without server-side one-time storage. `id_token` is decoded without signature/claim verification at [google-oauth-callback/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/google-oauth-callback/index.ts:47>).  
   **Recommendation**: Add an OAuth hardening unit before demo readiness or explicitly record it as accepted risk. Prefer storing nonce with expiry and verifying/deleting it atomically; verify Google ID token claims or fetch userinfo.

8. **Category**: safety  
   **Severity**: important  
   **Finding**: EU-17 asks to document Supabase Vault secret creation, edge function secrets, Netlify env vars, and encourages screenshots in `docs/manual-process-journal.md`. That creates a direct path to committing secret values or sensitive dashboard screenshots, despite `.gitignore` protecting only `.env*` files at [.gitignore](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/.gitignore:6>).  
   **Recommendation**: Add explicit journal rules: names and purpose only, never values; redact/crop screenshots; no client secret, refresh token, service role key, `CRON_SECRET`, or Vault plaintext.

9. **Category**: performance  
   **Severity**: important  
   **Finding**: EU-14 says “200 messages per cron run,” but the current collector loads all active accounts and loops each account at [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:114>) and [gmail-collector/index.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/functions/gmail-collector/index.ts:126>). In practice this becomes 200 messages per account per run, followed by sequential full-message fetches.  
   **Recommendation**: Correct the claim or add account batching/lease logic. Also prevent overlapping cron runs if a backfill takes longer than the 5-minute schedule in [20260617000003_cron_collector.sql](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/supabase/migrations/20260617000003_cron_collector.sql:9>).

10. **Category**: completeness  
    **Severity**: important  
    **Finding**: EU-15 says to show an account email badge in `MessageItem`, but `MessageListItem` only contains message columns in [messages.service.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/services/messages.service.ts:5>), and `MessageItem` only receives the message object at [MessageItem.tsx](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/components/email/MessageItem.tsx:4>).  
    **Recommendation**: Specify the data path: either join `connected_accounts(email_address)` in `getMessages()` or build an `accountId -> email` map from `useAccounts()` in `EmailPage` and pass the label through `MessageList`.

11. **Category**: integration  
    **Severity**: important  
    **Finding**: EU-15 does not mention React Query cache keys. `useMessages` currently uses a fixed `['messages']` key at [useMessages.ts](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/hooks/useMessages.ts:5>). Passing a filter without including it in the key risks stale “All accounts” data being reused for a filtered view.  
    **Recommendation**: Make the query key `['messages', connectedAccountId ?? 'all']`; reset `selectedId` and `showDetail` when the filter changes.

12. **Category**: testing  
    **Severity**: important  
    **Finding**: EU-15 tests cover only the happy filtered path. Missing negative cases: RLS prevents another user’s account filter from returning data, unknown account ID returns empty, filter change clears selected detail, and account label fallback when the account row is missing.  
    **Recommendation**: Add service tests for `.eq('connected_account_id', id)` and UI tests using two accounts/messages with filter changes.

13. **Category**: rollback  
    **Severity**: important  
    **Finding**: No rollback plan exists. EU-14 changes persistent sync state (`sync_cursor`, `backfill_complete`, `backfill_page_token`) and cron behavior; a bad deploy can mark accounts complete or advance page tokens incorrectly.  
    **Recommendation**: Add rollback steps: pause cron, redeploy previous `gmail-collector`, snapshot affected `connected_accounts`, clear bad `backfill_page_token`, and restore/choose safe `sync_cursor` values before resuming.

14. **Category**: safety  
    **Severity**: suggestion  
    **Finding**: The safety section lists all five mandatory rules, but they are not tied to acceptance checks. EU-19 explicitly says to “show HTML rendering,” while the untrusted-content safety check depends on the iframe CSP/sandbox in [MessageDetail.tsx](</Users/caleb/Documents/Claude Code/gmail-knowledge-collector/src/components/email/MessageDetail.tsx:9>).  
    **Recommendation**: Add acceptance checks confirming no browser writes to `messages`, no token values in logs/docs, no external email-content calls, and HTML remains sandboxed with remote loads blocked.

**Summary**

Overall plan quality: **5/10**.

Top 3 risks:
1. EU-14 can silently skip messages during multi-run backfill because it does not persist a starting history cursor.
2. Existing RLS integrity is incomplete because `messages.user_id` is not constrained to the connected account owner.
3. Backfill expands stored data, but the UI still exposes only the latest 200 messages and lacks pagination/search.

Verdict: **needs revision before implementation**. The plan is directionally useful, but EU-14 and the database/security gaps need tightening before this is safe to build for a demo branch.
