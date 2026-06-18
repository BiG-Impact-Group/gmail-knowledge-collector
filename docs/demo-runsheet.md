# Demo Run Sheet — Gmail Knowledge Collector
**Show-and-tell:** Wednesday or Thursday 2026-06-25

---

## Pre-demo checklist

- [ ] Netlify deploy is live and reachable
- [ ] At least 2 Gmail accounts connected (verify in Supabase → Table Editor → connected_accounts)
- [ ] Emails visible in the viewer (at least 1 account has synced)
- [ ] Browser console shows no errors
- [ ] Network tab confirms no email content is sent to third-party URLs
- [ ] Tokens are not visible in the URL bar or browser console logs

---

## Step 1 — Sign-in

1. Open the Netlify URL in an incognito window.
2. Click **Continue with Google**.
3. Sign in with the demo Google account.
4. Land on the **Connected Accounts** page — you should see at least 1 account card.

**Talking point:** "Single sign-on via Google. The app never sees the password."

---

## Step 2 — Connect a second account

1. Click **Connect Gmail** at the top of the Accounts page.
2. Choose a different Google account in the consent screen.
3. Grant the requested Gmail read-only permission.
4. Return to the Accounts page — you should now see 2 account cards, each with email address, status badge, and last-synced time.

**Talking point:** "Each card is a separate Google account. You can connect as many as you want. The platform is designed to scale to many connectors — same flow for Google Drive or Slack in weeks 2 and 3."

---

## Step 3 — Wait for collector

1. The cron job runs every 5 minutes.
2. Explain: "Behind the scenes, a serverless function polls each connected account and stores emails in Postgres."
3. Refresh the Accounts page — the "Last synced" time on the cards updates as each account syncs.

**Talking point:** "No manual sync button needed. It runs automatically and picks up where it left off. We're collecting the last 12 months of email per account — that runs across several cron cycles, about an hour per account."

---

## Step 4 — View emails

1. Click **View Emails →** on the Accounts page.
2. The list shows emails from both accounts, newest first.
3. If 2 accounts are connected, use the **account filter dropdown** in the header to filter to one account at a time.
4. Point out the **account badge** below each sender name — shows which inbox the email came from.
5. Click an email — the right pane shows the full HTML-rendered message.

**Talking point:** "Each row shows which account it came from. The filter lets you isolate one inbox or see everything together. The preview renders the actual HTML email, sandboxed so no external resources load and no scripts run."

---

## Step 5 — Load more

1. Scroll to the bottom of the message list.
2. Click **Load more** to fetch the next 200 messages.
3. The list appends without a page reload.

**Talking point:** "We collect 200 messages per sync run. The viewer loads them in pages of 200. A 12-month inbox of ~2,400 emails loads in about 12 pages."

---

## Step 6 — Talking points (wrap up)

- **What we built:** Collect, store, and display email from multiple Gmail accounts — all in a Postgres database.
- **12-month backfill:** Careers-worth of email, not just the most recent 200.
- **Generic platform:** The connector architecture supports Google Drive (week 2) and Slack (week 3) without rebuilding the auth or storage layer.
- **Future:** Vector store + embeddings for semantic search, then chat-over-data for retiring Town of Fishers employees.

---

## Out-of-scope callouts (if asked)

- **No search yet** — collect and gather only; semantic search is week 4.
- **No vector store** — embeddings come after collection is solid.
- **Drive / Slack not connected yet** — that's the next two weeks.
- **No AI processing of email content** — deliberate; PII safety before we feed it anywhere.

---

## Safety checks (run before presenting)

- [ ] No email body content appears in browser network requests to external URLs
- [ ] Supabase anon key is in code but has Row Level Security — users only see their own data
- [ ] Refresh tokens are in Supabase Vault, not in any browser response
- [ ] No secrets in the repo (confirm with `git log --oneline -5` that `.env` was never committed)
