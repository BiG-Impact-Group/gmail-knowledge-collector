## Summary

- **EU-14** — Paginated 12-month Gmail backfill with `backfill_start_history_id` captured before page 1 to prevent coverage gap during multi-run backfill
- **EU-15** — Account attribution badge on email list, per-account filter dropdown (shown only for 2+ accounts), and "Load more" pagination in the email viewer
- **EU-16** — Generic connector seam: `Provider` type, `ConnectorConfig` interface, `initiateOAuth(provider)` replacing `initiateGoogleOAuth`
- **EU-17** — Manual process journal (`docs/manual-process-journal.md`) covering GCP, Supabase, and Netlify setup steps
- **EU-18** — Git pre-commit hook (lint + test) via `.githooks/pre-commit` + `prepare` script
- **EU-19** — Demo run sheet (`docs/demo-runsheet.md`)

**Security fixes (all Codex CRITICAL/BUG findings resolved):**
- Finding 3 (CRITICAL) — OAuth nonce now stored in `oauth_nonces` table; callback atomically consumes it — replay window closed
- Finding 4 (BUG) — Composite FK `messages(user_id, connected_account_id) → connected_accounts(user_id, id)` enforces DB-level invariant that `messages.user_id` matches the account owner
- Finding 5 (BUG) — `extractEmailFromIdToken` replaced with Google userinfo endpoint call; `email_verified` assertion required
- Stricter iframe CSP (`default-src 'none'`, all network sources blocked)
- `getAccounts()` select narrowed to browser-required columns only
- Token values stripped from all error logs
- Account status set to `'error'` before Vault write, flipped to `'active'` only on success
- UTF-8 decoder used for base64url email body content
- `historyId` fetched from `users/me/profile` after initial sync (not from `messages.list`)
- `sync_cursor` reset to null on 404 from History API to trigger clean resync

**Migrations:**
- `20260618000001_backfill_columns.sql` — adds `backfill_complete`, `backfill_page_token`, `backfill_start_history_id` to `connected_accounts`
- `20260618000002_messages_user_fk.sql` — composite FK `messages(user_id, connected_account_id)` → `connected_accounts(user_id, id)` for RLS integrity
- `20260618000003_oauth_nonces.sql` — `oauth_nonces` table for nonce-based OAuth replay protection

Closes #17, closes #18, closes #19, closes #20, closes #21, closes #22

## Test plan

- [ ] TypeScript: `npm run typecheck` — clean
- [ ] Lint: `npm run lint` — clean
- [ ] Tests: `npm test` — 38 passed, 0 failed
- [ ] Migrations deployed: `npx supabase migration list --linked` — all 6 migrations in Remote column
- [ ] Browser smoke test on Netlify preview URL
  - [ ] Login with Google account
  - [ ] Connect Gmail account on `/accounts`
  - [ ] Emails load on `/emails`, filter shows when 2+ accounts
  - [ ] Load more button appears with >200 messages
  - [ ] HTML email renders in sandboxed iframe (no external resources)
  - [ ] Backfill runs to completion (check `backfill_complete` column)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
