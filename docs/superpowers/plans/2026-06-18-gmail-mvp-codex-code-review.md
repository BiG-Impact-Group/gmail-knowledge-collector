# Codex Code Review — Gmail MVP

**Date:** 2026-06-18
**Model:** gpt-5.5 (ChatGPT auth — o3/o4-mini not available on this account)

---

**Findings**

1. **File**: `src/components/email/MessageDetail.tsx:41-44`  
   **Category**: security  
   **Severity**: critical  
   **Finding**: Raw collected email HTML is rendered with `srcDoc={message.body_html}` and `sandbox="allow-same-origin"`. Even without scripts, remote images/CSS/fonts in email HTML can make third-party network requests, leaking viewing activity and tracking identifiers. This violates the PII containment rule.  
   **Fix**: Sanitize/rewrite HTML before rendering. Block remote loads with an injected CSP such as `default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'`; remove `allow-same-origin` unless strictly required.

2. **File**: `supabase/functions/google-oauth-callback/index.ts:94-97`  
   **Category**: security  
   **Severity**: critical  
   **Finding**: Raw OAuth token endpoint response bodies are logged: `console.error('Token exchange failed:', tokenRes.status, body)`. OAuth/token responses must be treated as sensitive; this creates a token/secret logging path.  
   **Fix**: Never log token endpoint bodies. Log only sanitized metadata:
   ```ts
   const err = await tokenRes.json().catch(() => ({}))
   console.error('Token exchange failed', { status: tokenRes.status, error: err.error })
   ```

3. **File**: `supabase/functions/google-oauth-initiate/index.ts:18-21`, `supabase/functions/google-oauth-callback/index.ts:39-43`  
   **Category**: security  
   **Severity**: critical  
   **Finding**: OAuth `nonce` is generated but never stored or checked. Callback verifies signature/expiry only, so a captured state can be replayed during its 5-minute window.  
   **Fix**: Store nonce server-side with `user_id` and expiry, then validate and delete it atomically in callback before token exchange.

4. **File**: `supabase/migrations/20260617000001_initial_schema.sql:40-44`, `:67-71`  
   **Category**: database  
   **Severity**: bug  
   **Finding**: `messages.user_id` drives RLS, but the DB does not enforce that it matches `connected_accounts.user_id`. A bad service-role write could attach user B’s account/message to user A’s `user_id`, and RLS would expose it.  
   **Fix**: Add an invariant, e.g. unique `(id, user_id)` on `connected_accounts` plus composite FK from `messages(connected_account_id, user_id)`, or a trigger that derives `messages.user_id` from the account.

5. **File**: `supabase/functions/google-oauth-callback/index.ts:46-48`  
   **Category**: security  
   **Severity**: bug  
   **Finding**: `id_token` is decoded without verifying signature, issuer, audience, expiry, or `email_verified`: `JSON.parse(base64urlDecode(idToken.split('.')[1]))`.  
   **Fix**: Verify Google JWT claims using Google JWKS or call Google’s tokeninfo/userinfo endpoint, and require `aud === GOOGLE_CLIENT_ID`, valid `iss`, unexpired `exp`, and `email_verified`.

6. **File**: `supabase/functions/google-oauth-callback/index.ts:122-129`, `:153-169`; `supabase/functions/gmail-collector/index.ts:130-134`  
   **Category**: correctness  
   **Severity**: bug  
   **Finding**: Account is saved as `status: 'active'` before the refresh token is stored. If Vault write fails, the collector later logs “No vault secret” and leaves the account active forever.  
   **Fix**: Insert/upsert as `pending` or `error` until Vault succeeds, then mark `active`. In collector, missing Vault secret should mark the account `error`.

7. **File**: `supabase/functions/gmail-collector/index.ts:154-165`, `:211-218`  
   **Category**: correctness  
   **Severity**: bug  
   **Finding**: First sync expects `messages.list` to return `historyId`: `newCursor = data.historyId ?? null`. Gmail `messages.list` does not provide a mailbox cursor, so `sync_cursor` stays null and first sync repeats every run.  
   **Fix**: After first sync, call `users.getProfile` and store `historyId`, or fetch full messages and store the max message `historyId`.

8. **File**: `supabase/functions/gmail-collector/index.ts:167-171`  
   **Category**: correctness  
   **Severity**: bug  
   **Finding**: Expired/invalid Gmail history cursors are not handled. Any non-OK history response just increments `errors` and keeps the stale cursor.  
   **Fix**: Detect 404/history-too-old responses, reset cursor, perform a bounded full resync, and store a fresh profile `historyId`.

9. **File**: `src/services/messages.service.ts:8-10`, `:18-19`  
   **Category**: performance  
   **Severity**: bug  
   **Finding**: Browser list query does `.select('*')` with no limit, returning every full email body to render the list. This is unbounded and unnecessarily expands the PII surface.  
   **Fix**: List query should select only metadata and paginate:
   ```ts
   .select('id,from_address,subject,snippet,internal_date')
   .order('internal_date', { ascending: false })
   .range(0, 99)
   ```

10. **File**: `supabase/functions/gmail-collector/index.ts:113-116`, `:182-203`  
    **Category**: performance  
    **Severity**: improvement  
    **Finding**: Collector fetches all active accounts without a batch limit, then does per-message Gmail fetches and per-message DB upserts sequentially. This will time out or hit rate limits as accounts grow.  
    **Fix**: Batch accounts, add a lease/claim mechanism, use bounded concurrency, and bulk upsert collected messages per account.

11. **File**: `supabase/functions/gmail-collector/index.ts:26-29`, `:38-51`  
    **Category**: correctness  
    **Severity**: bug  
    **Finding**: `base64urlDecode` returns `atob(padded)`, a binary string, not UTF-8 decoded text. Non-ASCII email bodies will corrupt.  
    **Fix**: Decode to bytes and run `new TextDecoder('utf-8').decode(bytes)`, with charset fallback if needed.

12. **File**: `src/components/auth/LoginPage.tsx:12-15`; `package.json:20-24`  
    **Category**: correctness  
    **Severity**: bug  
    **Finding**: The plan says React 18, React Router v6, Vite frontend, and email/password Supabase Auth. This implements Google Supabase OAuth login and uses React 19 / Router 7 / Vite 8.  
    **Fix**: Align implementation with the accepted stack and auth flow, or update the spec and tests explicitly.

**Mandatory Safety Check**

- Tokens server-side only: mostly followed, but raw OAuth token response logging is a critical violation risk.
- Browser read-only on `messages`: migration only creates SELECT policy for `authenticated`; no INSERT/UPDATE/DELETE policy found.
- PII containment: violated by raw email HTML rendering that can load third-party resources.
- Secrets out of git: `.env.example` uses placeholders; no real secret found in reviewed files.
- Untrusted content: raw `body_html` reaches `iframe srcDoc`; needs sanitization and network blocking.

Overall code quality score: **4/10**

Top 3 highest-risk areas: OAuth callback/state handling, raw email HTML rendering, collector cursor/error handling.

Files needing most attention: `supabase/functions/google-oauth-callback/index.ts`, `supabase/functions/gmail-collector/index.ts`, `src/components/email/MessageDetail.tsx`, `supabase/migrations/20260617000001_initial_schema.sql`.

Verdict: **needs significant rework before shipping**.
tokens use