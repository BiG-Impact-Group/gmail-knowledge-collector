# Epic Spec: Demo-Readiness
**Slug:** demo-readiness  
**Branch:** plan/demo-readiness → feature/demo-readiness  
**Date:** 2026-06-18  
**Author:** Planner agent  
**Status:** Approved — Gate 2 passed (Codex review 2026-06-18, findings triaged)

---

## Context

The Gmail Knowledge Collector MVP (Epics 01 + 02) is merged to `main`. The next show-and-tell is Wednesday or Thursday 2026-06-25. This epic closes the gaps identified in the Phase A audit before that demo.

Source of truth: Tuesday 2026-06-16 meeting transcript (Terrence Kunstek, Caleb Crane, Cloee Kunstek) and the Phase A gap report.

---

## Approved scope

### EU-14 — Paginated 12-month backfill

**Why:** The current collector fetches 200 messages on first sync and stops. The use case (Town of Fishers snow plow workers retiring) requires career-spanning email — 200 messages is insufficient. 12 months is the agreed starting depth; widening it later requires only clearing `sync_cursor` and `backfill_complete`.

**What:**
- Add three columns to `connected_accounts` (idempotent migration):
  - `backfill_complete boolean NOT NULL DEFAULT false`
  - `backfill_page_token text`
  - `backfill_start_history_id text` — historyId captured **before** page 1 is fetched; used as `sync_cursor` when backfill finishes
- Collector logic:
  - **If `backfill_complete = false`:**
    1. On the very first run for an account (no `backfill_start_history_id`): call `GET users/me/profile` to get the current `historyId`. Store it as `backfill_start_history_id`. This is the only safe cursor — it covers any messages that arrive **during** the multi-run backfill.
    2. Call `messages.list` with `maxResults=200` and `q=after:YYYY/MM/DD` (12 months ago). Follow `nextPageToken` across cron runs via `backfill_page_token`.
    3. On the final page (no `nextPageToken`): set `backfill_complete = true`, clear `backfill_page_token`, set `sync_cursor = backfill_start_history_id`. From this point the History API path takes over.
  - **If `backfill_complete = true`:** use the existing History API incremental path (unchanged).
- Rate: 200 messages per cron run per account during backfill. A typical 12-month inbox (~2,400 messages) completes in 12 runs (~1 hour at 5-min cron).
- Existing accounts with `sync_cursor` set but `backfill_complete = false` (default after migration) re-enter the backfill path on next run. Intentional — their existing cursor was set on a 200-message partial sync.

**Why `backfill_start_history_id`:** Without it, messages arriving in the inbox during a multi-run backfill have historyIds between the backfill start and end. Setting `sync_cursor` from `users/me/profile` at the end of the backfill skips those messages permanently. Capturing the historyId before page 1 ensures the History API replay covers the entire backfill window.

**Deployment order:**
1. Apply migration (`npx supabase db push --linked`)
2. Run `npm run gen:types` and commit updated `database.types.ts`
3. Deploy updated `gmail-collector` edge function (`npx supabase functions deploy gmail-collector`)

**Rollback:** If backfill goes wrong for an account, clear `backfill_complete`, `backfill_page_token`, and `backfill_start_history_id` in the Supabase dashboard for that row. Next cron run restarts cleanly.

**Migrations:**
- `20260618000001_backfill_columns.sql` — adds `backfill_complete`, `backfill_page_token`, `backfill_start_history_id` with `ADD COLUMN IF NOT EXISTS`
- `20260618000002_messages_user_fk.sql` — adds composite FK enforcing `messages.user_id` → `connected_accounts(user_id)` (see RLS integrity below)

**Tests:** Extract the following as pure, side-effect-free functions in the collector and cover with Jest unit tests:
- `buildBackfillQuery(after: string, pageToken?: string): string` — constructs the `messages.list` URL
- `shouldStartBackfill(account: { backfill_start_history_id: string | null }): boolean`
- `isBackfillComplete(pageToken: string | null): boolean`

The stateful parts (fetch calls, DB writes, vault reads) remain in the Edge Function body and are covered by the Gate 7 browser smoke test. Do not attempt to run the Edge Function itself in Jest.

**Out of scope for EU-14:** Progress UI, rate-limit (429) backoff.

---

### EU-15 — Account attribution in email viewer

**Why:** Connecting multiple accounts is invisible in the current viewer — all emails look identical regardless of source inbox. Terrence stated at 00:30:10 that one user must be able to connect an infinite number of accounts. Without attribution, the multi-inbox capability cannot be demonstrated.

**What:**
- Add an account label (email address) to each row in the `MessageItem` component. Position: small muted badge below the sender name.
- Add an account filter dropdown/selector in the `EmailPage` list pane header. Options: "All accounts" + one entry per connected account. Selecting an account filters the list.
- `getMessages()` in `messages.service.ts` accepts an optional `connectedAccountId?: string` parameter; when provided, adds `.eq('connected_account_id', id)` to the query before `.order()`.
- `useMessages(connectedAccountId?: string)` hook: passes the filter through from `EmailPage` state. Cache key must be `['messages', connectedAccountId ?? 'all']` — **not** `['messages']` — or stale data from the unfiltered view will show when a filter is selected.
- **Account badge data path:** `MessageListItem` only has `connected_account_id`, not the account email. Build an `accountId → emailAddress` lookup map in `EmailPage` from `useAccounts()` and pass it to `MessageItem` as a `accountEmail?: string` prop. No query join needed; no change to `getMessages()` select columns.
- Add a "Load more" button below the message list in `EmailPage`. On click, increment the page offset by 200 and fetch the next range via `getMessages()` with `.range(offset, offset + 199)`. Append results to the existing list. Without this, backfilled mail (potentially thousands of messages) is unreachable in the demo.

**No new RLS or migrations required** — `connected_account_id` already exists on `messages`.

**Tests:**
- Update `messages.service.test.ts` to cover the filtered path (`.eq()` called with the account ID, cache key includes filter).
- Update `EmailPage` test for filter state change and "Load more" triggering next range.
- Negative cases: filter with no messages returns empty state; "Load more" when no more results hides the button.

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
- **Redaction rule:** Document setting names and their purpose only. Never record actual values (client IDs, secrets, keys, URLs with tokens). If a step requires a specific value, note where to find it (e.g., "copy from Google Console → Credentials → OAuth 2.0 Client IDs") but do not paste the value itself.

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
  1. Pre-demo checklist (confirm Netlify is live, confirm at least 2 accounts connected, confirm emails visible, confirm no secrets in browser console/network tab)
  2. Sign-in walkthrough (go to URL, click Continue with Google, land on Accounts page)
  3. Connect a second account (click Connect Gmail, grant consent, return to Accounts with 2 cards)
  4. Wait for collector (explain the 5-minute cron, refresh)
  5. View emails (navigate to Emails, use account filter to show each inbox separately, click one, show HTML rendering)
  6. Load more (click Load more to show pagination works, demonstrating backfill depth)
  7. Talking points (12-month backfill, generic platform, future: Drive, Slack, calendar)
  8. Out-of-scope callouts (no search yet, no vector store — collect and gather only)
  9. Safety checks: verify no email content appears in browser network tab requests to third-party URLs; verify no tokens visible in URL bar or console

---

## Known accepted risks (demo scope)

The following security gaps are explicitly accepted for the internal demo (Google Testing Mode, team-only test users). They are **not** acceptable in production and must be addressed before any external user onboarding.

- **OAuth nonce not validated server-side:** The HMAC-SHA256 state JWT is generated but the nonce is not stored server-side, so a captured state JWT can be replayed within its 5-minute window. Attack surface: team members only.
- **`id_token` not signature/claim verified:** The `id_token` returned from Google's token endpoint is decoded but not verified against Google's public keys or audience claim. The token comes from Google's endpoint over HTTPS, making tampering unlikely in the team context. Both items are week-3 hardening targets.

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
- OAuth nonce server-side storage + id_token verification — week 3

---

## Migration checklist

| File | Change | Idempotent? |
|---|---|---|
| `20260618000001_backfill_columns.sql` | ADD COLUMN IF NOT EXISTS `backfill_complete`, `backfill_page_token`, `backfill_start_history_id` | Yes |
| `20260618000002_messages_user_fk.sql` | ADD CONSTRAINT IF NOT EXISTS composite FK `messages(user_id)` → `connected_accounts(user_id)` | Yes |

---

## Issue decomposition

| Issue | Title | Epic unit |
|---|---|---|
| #1 | feat: paginated 12-month backfill in gmail-collector | EU-14 |
| #2 | feat: account attribution, filter, and load-more in email viewer | EU-15 |
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
4. Secrets never in git. Journal entries document setting names only, never values.
5. Email content is untrusted input — no LLM feeding in this epic.
