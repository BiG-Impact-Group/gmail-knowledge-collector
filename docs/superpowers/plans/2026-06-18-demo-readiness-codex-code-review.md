1. **File**: `src/services/accounts.service.ts:7-14`; `src/types/database.types.ts:19-21`
   **Category**: security
   **Severity**: bug (should fix)
   **Finding**: `getAccounts()` returns every `connected_accounts` column to the browser via `select('*')`. The new backfill fields now include internal Gmail collection state: `backfill_page_token`, `backfill_start_history_id`, and `sync_cursor`. Even though these are not OAuth refresh/access tokens, they are provider-side cursors/tokens and should remain server-only collector state.
   **Fix**: Return only browser-required fields.
   ```ts
   .select('id, provider, email_address, status, granted_scopes, last_synced_at, created_at, updated_at')
   ```

2. **File**: `src/components/email/MessageDetail.tsx:9-11,46-50`
   **Category**: security
   **Severity**: critical (must fix)
   **Finding**: Raw collected email HTML reaches `iframe srcDoc` without sanitization: `srcDoc={wrapWithCsp(message.body_html)}`. The CSP helps, but untrusted email markup is still rendered as HTML and can contain navigation/meta/link/form constructs that should not be trusted in a PII-heavy app.
   **Fix**: Sanitize or render a safe transformed subset before `srcDoc`; strip active/navigation/resource-loading elements and attributes. Add stricter CSP directives such as `base-uri 'none'; form-action 'none'; navigate-to 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; connect-src 'none'`.

3. **File**: `supabase/functions/gmail-collector/index.ts:196-199,263-270`
   **Category**: correctness
   **Severity**: bug (should fix)
   **Finding**: The collector persists `backfill_start_history_id` in a separate unchecked update, then later saves `backfill_page_token`. If the first update fails and the second succeeds, the next run resumes page 2+ with `backfill_start_history_id = null`, captures a later history cursor, and can permanently miss mail that arrived during page 1.
   **Fix**: Check the update error and stop on failure, or persist `backfill_start_history_id` atomically with every page-token update.
   ```ts
   const update = await supabaseAdmin
     .from('connected_accounts')
     .update({ backfill_start_history_id: startHistoryId, backfill_page_token: listData.nextPageToken })
     .eq('id', account.id)
   if (update.error) { errors++; continue }
   ```

4. **File**: `supabase/functions/gmail-collector/index.ts:221-245,248-270,305-339`
   **Category**: correctness
   **Severity**: bug (should fix)
   **Finding**: Individual message failures are swallowed, but the collector still advances `backfill_page_token`, marks backfill complete, or advances `sync_cursor`: `catch { // Skip individual message failures }`. Any failed fetch/upsert is then skipped permanently.
   **Fix**: Track per-message failures and do not advance the page token or history cursor unless all messages for that page are persisted successfully. Mark the account `error` or retry failed message IDs.

5. **File**: `supabase/functions/gmail-collector/index.ts:275-303,332-339`
   **Category**: correctness
   **Severity**: bug (should fix)
   **Finding**: Gmail History API pagination is ignored. The code reads one `users/me/history` response and advances to `histData.historyId`, but Gmail can return `nextPageToken`; unprocessed later pages will be skipped.
   **Fix**: Loop through history pages until no `nextPageToken`, collect/process all `messagesAdded`, and only then update `sync_cursor`.

6. **File**: `src/services/messages.service.ts:16-18`; `src/hooks/useMessages.ts:8-9`
   **Category**: correctness
   **Severity**: bug (should fix)
   **Finding**: Infinite pagination uses offset ranges against a live, descending inbox: `.order('internal_date', { ascending: false }).range(offset, offset + 199)`. New mail arriving between page loads shifts offsets, causing duplicate or skipped messages. Ties on `internal_date` are also nondeterministic.
   **Fix**: Use keyset pagination with a stable secondary order, e.g. `internal_date DESC, id DESC`, and pass the last row cursor instead of `allPages.length * 200`.

7. **File**: `supabase/functions/gmail-collector/index.ts:142-154,221-241,305-325`
   **Category**: performance
   **Severity**: bug (should fix)
   **Finding**: The cron run selects all active accounts without a limit and processes up to 200 full-message fetches per account sequentially. With many accounts, one run can exceed edge-function time limits and overlap the next cron run.
   **Fix**: Add a bounded batch query, a lease/lock column such as `sync_locked_until`, and bounded concurrency for message fetches. Do not let overlapping runs process the same account.

8. **File**: `supabase/migrations/20260618000002_messages_user_fk.sql:31-34`; `src/types/database.types.ts:114-122`
   **Category**: database
   **Severity**: improvement (nice to have)
   **Finding**: The migration adds `messages_user_id_connected_account_fk`, but generated types still list only `messages_connected_account_id_fkey`. This suggests the type generation step was incomplete or hand-edited.
   **Fix**: Re-run `npm run gen:types` after applying migrations and commit the regenerated `database.types.ts`.

9. **File**: `src/components/email/EmailPage.test.tsx:58-65`
   **Category**: quality
   **Severity**: improvement (nice to have)
   **Finding**: The negative filter test asserts synchronously immediately after render: `expect(screen.queryByRole('combobox')).not.toBeInTheDocument()`. That can pass before the accounts query resolves, so it does not prove the one-account loaded state hides the dropdown.
   **Fix**: Wait for the mocked account data to settle before asserting absence, e.g. `await waitFor(() => expect(mockAccountsOrder).toHaveBeenCalled())`, then assert no combobox.

- Overall code quality score: 6/10
- Top 3 highest-risk areas: raw email HTML rendering, collector cursor/page-token advancement, Gmail History API pagination
- Files that need the most attention: `supabase/functions/gmail-collector/index.ts`, `src/components/email/MessageDetail.tsx`, `src/services/accounts.service.ts`
- Verdict: needs fixes before shipping