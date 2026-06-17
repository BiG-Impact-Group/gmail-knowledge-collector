# Gmail Knowledge Collector — Week-One MVP Design

**Slug:** gmail-mvp  
**Date:** 2026-06-17  
**Status:** Draft — awaiting Codex plan review  
**Epics:** 2  
**Author:** Claude Sonnet 4.6 + Caleb Crane

---

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-06-17 | Initial spec from brainstorm |

---

## 1. Goals

Deliver a working end-to-end Gmail knowledge collection system in one week:

1. A user signs in via Supabase Auth.
2. The user connects one or more Gmail accounts via OAuth (unlimited accounts per user).
3. A scheduled background job collects email from every connected account.
4. A two-pane viewer shows subjects/snippets on the left and the full email (including HTML) on the right.
5. Deployed to Netlify. Google app in Testing status. Demonstrable end-to-end.

---

## 2. Out of scope

Do not build, do not stub, note as future work only:

- Google Drive, Slack, Calendar, any non-email source
- Vector store, search, chat over collected data
- Any Gmail write/send/modify scope
- Production verification (CASA) for external users
- Realtime subscriptions (React Query polling is sufficient)
- Email pagination / infinite scroll in the viewer
- Multi-account filtering in the viewer

---

## 3. Epic structure

| Epic | Branch | Scope |
|---|---|---|
| Epic 01 — Foundation & Connect | `feature/epic-01-foundation-connect` | Scaffolding, Auth, data model, OAuth connect flow |
| Epic 02 — Collect & View | `feature/epic-02-collect-view` | Collector edge function, Cron, two-pane viewer, Netlify deploy |

Epic 02 depends on Epic 01's migrations being live in the remote DB and at least one connected account existing.

---

## 4. Data model

### 4.1 `connected_accounts`

```sql
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'google',
  email_address     text NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'error', 'revoked')),
  granted_scopes    text,
  sync_cursor       text,            -- Gmail historyId after first sync
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email_address)
);

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own accounts"
  ON connected_accounts FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- No INSERT/UPDATE/DELETE for authenticated — edge functions write via service role
```

Indexes:
- `(user_id)` — primary access pattern for the viewer
- `(user_id, status)` — filter active accounts in UI

### 4.2 `messages`

```sql
CREATE TABLE IF NOT EXISTS messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id  uuid NOT NULL
                        REFERENCES connected_accounts(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,  -- denormalized for cached RLS subselect
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
  UNIQUE (connected_account_id, gmail_message_id)
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users select own messages"
  ON messages FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id);

-- No INSERT/UPDATE/DELETE for authenticated — collector writes via service role
```

Indexes:
- `(user_id, internal_date DESC)` — primary viewer query
- `(user_id, connected_account_id, internal_date DESC)` — future per-account filtering
- `(connected_account_id)` — cascade delete performance

### 4.3 Token storage

OAuth refresh tokens are stored in Supabase Vault (not in any table). Each connected account's vault secret is keyed by `connected_account_id`. Access tokens are derived at runtime by the collector edge function and never persisted.

### 4.4 TypeScript types

After every `supabase db push`, run `npm run gen:types` and commit the updated `src/types/database.types.ts` alongside the migration file. This is mandatory — the build will drift without it.

---

## 5. Architecture

### 5.1 Application routing

```
/                   → redirect to /login if unauthenticated, else /accounts
/login              → Supabase Auth email+password login
/accounts           → Connected accounts list + "Connect Gmail" button
/emails             → Two-pane email viewer
```

### 5.2 OAuth connect flow

```
Browser                      Edge Fn: google-oauth-initiate        Google
  |                                  |                               |
  |-- GET /accounts ─────────────────►                               |
  |   user clicks "Connect Gmail"    |                               |
  |-- POST /functions/v1/google-oauth-initiate                       |
  |                                  |-- build state JWT (HMAC)      |
  |◄── 302 redirect ─────────────────|   (user_id + nonce + expiry)  |
  |                                  |                               |
  |── user grants consent ──────────────────────────────────────────►|
  |                                                                  |
  |                          Edge Fn: google-oauth-callback          |
  |◄─────────────── redirect with ?code=...&state=... ──────────────|
  |                                  |── validate state JWT          |
  |                                  |── exchange code → tokens      |
  |                                  |── store refresh token in Vault|
  |                                  |── upsert connected_account    |
  |◄── redirect to /accounts ────────|
```

Two edge functions:
- `google-oauth-initiate` — builds the Google authorization URL with a signed state parameter and redirects the browser. Called from the browser with the user's JWT.
- `google-oauth-callback` — Google's redirect target. Validates state, exchanges code, stores refresh token in Vault, upserts `connected_accounts` row. This is the registered redirect URI.

State parameter: a short-lived JWT signed with a secret from Vault. Contains `user_id`, `nonce`, `exp` (5 minutes). Prevents CSRF.

Registered redirect URI: `https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback`

### 5.3 Collector flow

```
Supabase Cron (pg_cron + pg_net)
  every 5 minutes → POST /functions/v1/gmail-collector
                    Authorization: Bearer <CRON_SECRET from Vault>
                         |
                         |── verify CRON_SECRET header
                         |── fetch all active connected_accounts (service role)
                         |── for each account:
                         |     fetch refresh_token from Vault
                         |     POST to Google token endpoint → access_token
                         |     if error → set status='error', continue
                         |     if no sync_cursor (first run):
                         |       fetch last 200 messages by date
                         |     else:
                         |       fetch history since sync_cursor (historyId)
                         |     decode base64url body parts
                         |     upsert into messages (service role, ON CONFLICT DO NOTHING)
                         |     update sync_cursor + last_synced_at
```

First sync: `messages.list` with `maxResults=200`, ordered by date descending.
Incremental: `history.list` with `startHistoryId=sync_cursor`, process `messagesAdded` events only.
On token error: set `connected_accounts.status = 'error'`, skip account, continue.
CRON_SECRET: stored in Vault, injected into the cron HTTP request header, verified by the collector.

### 5.4 Two-pane viewer

Left pane (message list):
- Shows: sender name/address, subject (or "(no subject)"), snippet, date (relative: "2h ago", "Jun 14")
- Sorted: newest first by `internal_date`
- Fetches all messages for the current user via React Query (no pagination for MVP)
- Highlights selected message

Right pane (message detail):
- Shows: from, to, subject, date (full), then HTML body in a sandboxed `<iframe srcdoc>` if `body_html` is present, else `body_text` in a `<pre>`
- `<iframe>` has `sandbox="allow-same-origin"` only — no scripts, no forms

Empty states:
- No accounts connected → "Connect a Gmail account to get started" + button to `/accounts`
- Accounts connected but no messages yet → "Your emails are being collected. Check back in a few minutes."
- Message selected but body is empty → "No content available for this message."

Auto-refresh: React Query `refetchInterval: 60_000` (60 seconds) on the message list query. No manual refresh button needed.

### 5.5 Service layer

```
src/
  lib/
    supabase.ts          -- Supabase client singleton
  services/
    accounts.service.ts  -- CRUD for connected_accounts (SELECT only for browser)
    messages.service.ts  -- SELECT queries for messages
  hooks/
    useAccounts.ts       -- React Query hook wrapping accounts.service
    useMessages.ts       -- React Query hook wrapping messages.service
    useMessage.ts        -- single message detail hook
  components/
    auth/
      LoginPage.tsx
    accounts/
      AccountsPage.tsx   -- list + connect button
      AccountCard.tsx    -- status badge, email address
    email/
      EmailPage.tsx      -- two-pane layout
      MessageList.tsx    -- left pane
      MessageItem.tsx    -- single row in list
      MessageDetail.tsx  -- right pane
    shared/
      EmptyState.tsx
      ErrorBoundary.tsx
  types/
    database.types.ts    -- auto-generated from Supabase schema
```

---

## 6. Epic 01 — Foundation & Connect

### Work units

**EU-01: Project scaffold**
Set up Vite + React 18 + TypeScript strict, React Router v6, React Query, React Hook Form + Zod, SCSS with design tokens, ESLint + Stylelint, Jest + RTL. Configure `@/` path alias. Add `npm run typecheck`, `npm run lint`, `npm test`, `npm run gen:types` scripts. Confirm `npm run build` produces no errors.

**EU-02: Supabase client and Auth**
Create `src/lib/supabase.ts` singleton. Implement `LoginPage` with email + password via `supabase.auth.signInWithPassword`. Implement sign-out. Protected route wrapper that redirects unauthenticated users to `/login`. React Query `QueryClient` wrapping the app.

**EU-03: Data model migration**
Write idempotent migration for `connected_accounts` and `messages` tables with all constraints, RLS policies, and indexes as specified in section 4. Run `supabase db push`. Run `npm run gen:types`. Commit both. Verify via `supabase migration list --db-url $DATABASE_URL`.

**EU-04: google-oauth-initiate edge function**
Edge function that accepts a request from an authenticated browser user, builds a Google OAuth authorization URL with `scope=https://www.googleapis.com/auth/gmail.readonly`, generates a signed state JWT (HMAC-SHA256, 5-minute expiry, contains `user_id` + `nonce`), stores the nonce in Vault temporarily, and returns a redirect to Google. Reads `GOOGLE_CLIENT_ID` and `STATE_SECRET` from Vault.

**EU-05: google-oauth-callback edge function**
Edge function at the registered redirect URI. Validates the state JWT (signature + expiry + nonce). Exchanges the authorization code for tokens via Google's token endpoint. Stores the refresh token in Vault keyed by a new `connected_account_id`. Upserts a `connected_accounts` row (status=active, granted_scopes, email_address from the id_token). Redirects the browser to `/accounts`. Reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STATE_SECRET` from Vault.

**EU-06: Accounts UI**
`AccountsPage` showing all connected accounts for the current user. Each `AccountCard` shows the Gmail address, provider badge, status badge (active/error/revoked), and `last_synced_at`. An error status shows "Reconnect" button. "Connect Gmail" button triggers `google-oauth-initiate`. `useAccounts` hook with React Query.

**EU-07: Epic 01 tests**
- Unit tests: `accounts.service.ts` (mock Supabase client), Zod schema validation for any form inputs, state JWT sign/verify logic (if extracted to a shared util)
- RTL: `LoginPage` (renders form, submits, shows error on failure), `AccountsPage` (renders account list, shows empty state, renders error badge)
- Edge function: Deno test for `google-oauth-callback` state validation logic (unit, no real HTTP calls)

### Acceptance criteria

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` all pass
- Migration appears in Remote column of `migration list --db-url $DATABASE_URL`
- Can sign in, see `/accounts`, click "Connect Gmail", complete OAuth, see the connected account appear with status=active
- No token appears in any browser network response or localStorage

---

## 7. Epic 02 — Collect & View

### Work units

**EU-08: gmail-collector edge function**
Scheduled collector as described in section 5.3. Fetches active connected accounts, retrieves refresh tokens from Vault, exchanges for access tokens, fetches messages (200 on first run, incremental via historyId thereafter), decodes base64url body parts (text/plain and text/html), upserts into `messages` via service role, updates `sync_cursor` and `last_synced_at`. Sets `status='error'` on any token failure. Reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` from Vault.

**EU-09: Supabase Cron setup**
SQL migration adding a pg_cron job that invokes `gmail-collector` every 5 minutes via pg_net. The HTTP request includes `Authorization: Bearer <CRON_SECRET>` read from Vault using `vault.decrypted_secrets`. Cron job name: `collect-gmail-every-5min`. Migration is idempotent (use `cron.schedule` with `IF NOT EXISTS` equivalent — `cron.unschedule` + `cron.schedule` inside a DO block).

**EU-10: Two-pane email viewer**
`EmailPage` with `MessageList` (left, ~35% width) and `MessageDetail` (right, ~65% width). `useMessages` hook with `refetchInterval: 60_000`. `MessageItem` shows sender, subject, snippet, relative date. Selected item highlighted. `MessageDetail` renders HTML body in sandboxed `<iframe srcdoc>` or `body_text` in `<pre>`. All three empty states implemented (no accounts, no messages, no body). Responsive: on narrow viewports, detail replaces list (back button to return).

**EU-11: Netlify deployment**
`netlify.toml` with build command (`npm run build`), publish dir (`dist`), and redirect rule (`/* /index.html 200` for SPA routing). Environment variables documented (add to Netlify dashboard: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Deploy to Netlify. Add the Netlify production URL to Google OAuth authorized JavaScript origins. Verify OAuth flow works end-to-end on the deployed URL.

**EU-12: Vault secrets setup**
Document and execute the Vault secret setup for all required secrets:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `STATE_SECRET` (random 32-byte hex, generated once)
- `CRON_SECRET` (random 32-byte hex, generated once)

Create a `docs/superpowers/runbooks/vault-setup.md` with the exact `supabase secrets set` commands (values redacted). These are set once and referenced by edge functions via `Deno.env.get()`.

**EU-13: Epic 02 tests**
- Unit tests: `messages.service.ts` (mock Supabase), base64url decode utility, Gmail history response parser
- RTL: `EmailPage` (renders empty state, renders list, clicking item shows detail), `MessageList` (renders items, highlights selected), `MessageDetail` (renders iframe for HTML, pre for text, empty state)
- Edge function: Deno test for `gmail-collector` — mock Gmail API responses, verify correct upsert payload, verify `sync_cursor` update, verify `status='error'` on token failure

### Acceptance criteria

- All tests pass, build clean
- Migrations in Remote column
- Collector runs on schedule and messages appear in the DB
- Two-pane viewer shows collected email, HTML renders in iframe
- Netlify deploy accessible, full OAuth + collection + view flow works end-to-end

---

## 8. Safety rules compliance

All five mandatory rules must be verified in both Codex reviews:

| Rule | Implementation |
|---|---|
| Tokens server-side only | Refresh tokens in Vault only. Access tokens derived at runtime, never stored. No token in any browser response. |
| Browser read-only on messages | No INSERT/UPDATE/DELETE RLS policy for `authenticated` on `messages`. Verified by reviewing migration SQL. |
| PII containment | No email content sent to any external API or model. Collector writes to Supabase only. |
| Secrets out of git | `.env` gitignored. All edge function secrets from `Deno.env.get()` via Vault. `.env.example` has no real values. |
| Untrusted content noted | `body_html` rendered in sandboxed iframe (`sandbox="allow-same-origin"` only). No scripts. Note in README that prompt injection shielding is required before any future LLM step. |

---

## 9. Test plan summary

| Layer | Tool | Coverage target |
|---|---|---|
| Services | Jest + mock Supabase client | All public functions |
| Hooks | Jest + React Query test utils | Query states (loading, success, error) |
| Components | RTL | Key components: LoginPage, AccountsPage, EmailPage, MessageList, MessageDetail |
| Edge functions | Deno test | Core logic: state JWT validation, token exchange error handling, collector upsert logic, history parsing |

No E2E tests (Playwright/Cypress) for this MVP. Manual smoke test covers end-to-end.

---

## 10. Open questions and assumptions

| # | Item | Decision |
|---|---|---|
| 1 | Cron interval | 5 minutes |
| 2 | First sync message cap | 200 messages, newest first |
| 3 | Token failure handling | Set status='error', skip account, surface in UI |
| 4 | Viewer auto-refresh | React Query refetchInterval 60s |
| 5 | HTML rendering | Sandboxed iframe, no scripts |
| 6 | Google OAuth publish status | Testing — add demo accounts as test users |
| 7 | Netlify preview URLs | Will not work for OAuth (no wildcard subdomains). Use production URL only. |
| 8 | pg_cron availability | Enabled by default on Supabase. Verify in dashboard if cron job doesn't fire. |
