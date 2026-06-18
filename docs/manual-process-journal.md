# Manual Process Journal — Gmail Knowledge Collector

> Document names and purpose only. **Never record actual values** (client IDs, secrets, tokens, keys).
> For each step, note where to find the value if needed, not the value itself.

---

## Google Cloud Console

### Project creation
**Date:** 2026-06-17  
**Platform:** console.cloud.google.com

1. Created a new GCP project (name matches the app name).
2. Enabled the **Gmail API** via APIs & Services → Library → search "Gmail API" → Enable.

### OAuth consent screen
**Platform:** APIs & Services → OAuth consent screen

1. Set User Type to **External**.
2. Added app name, support email, and developer contact email.
3. Under **Scopes**, added: `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Test users**, added all team Google accounts that will use the app during development.

**Gotcha:** Test users must be added here or they'll see "App not verified" and be blocked. Google Testing Mode limits to 100 test users.

### OAuth 2.0 credentials (Client ID)
**Platform:** APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID

1. Application type: **Web application**.
2. **Authorized JavaScript origins:** add your Supabase project URL (`https://<ref>.supabase.co`). Also add `http://localhost:5173` for local dev.
3. **Authorized redirect URIs:** add `https://<ref>.supabase.co/functions/v1/google-oauth-callback` (the exact redirect URI used in `google-oauth-callback/index.ts`).
4. Download the JSON client credentials. The **Client ID** and **Client Secret** go into Supabase edge function secrets (see Supabase section below). **Do not commit them.**

---

## Supabase

### Project creation
**Date:** 2026-06-17  
**Platform:** app.supabase.com

1. Created a new project (region closest to users).
2. Noted the **Project ref** (visible in Settings → General) — used in `npm run gen:types` and CLI commands.

### Auth → Google provider
**Platform:** Authentication → Providers → Google

1. Enabled Google provider.
2. Pasted the **Client ID** and **Client Secret** from the GCP credentials JSON.
3. The **Callback URL** shown here is the redirect URI — must exactly match the Authorized redirect URI in GCP.

### Site URL and redirect URLs
**Platform:** Authentication → URL Configuration

1. **Site URL:** set to the Netlify production URL (e.g., `https://<app>.netlify.app`).
2. **Redirect URLs:** added the Netlify URL and `http://localhost:5173` for local dev.

**Gotcha:** If the Site URL doesn't match, post-OAuth redirects land on a Supabase page instead of the app. Update this whenever the Netlify URL changes.

### Vault secrets
**Platform:** Edge Functions → Secrets (or SQL editor via vault.create_secret)

Secrets stored in Vault (accessible to edge functions via `Deno.env.get()`):

| Secret name | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID from GCP |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret from GCP |
| `STATE_SECRET` | Random 32+ character string used to sign/verify state JWTs. Generate with `openssl rand -hex 32`. |
| `CRON_SECRET` | Secret used by the pg_cron job to authenticate HTTP requests to gmail-collector. Generate with `openssl rand -hex 32`. |

**How to add/update a secret via SQL:**
```sql
select vault.create_secret('the-value-here', 'SECRET_NAME', 'description');
-- or update:
select vault.update_secret('new-value', (select id from vault.secrets where name = 'SECRET_NAME'));
```

**Gotcha:** After adding a secret, redeploy the edge function for it to see the new value.

### Cron job setup
**Platform:** SQL editor

After running all migrations, the cron job is created automatically by `20260617000003_cron_collector.sql`. Verify it exists:

```sql
select * from cron.job;
```

The job calls the `gmail-collector` function every 5 minutes. The `CRON_SECRET` value must match what's in Vault or every cron run will return 401.

### Migrations
**How to apply:**
```bash
npx supabase db push --linked
```

**How to verify:**
```bash
npx supabase migration list --linked
```

All migration files in `supabase/migrations/` should appear in the **Remote** column.

### Type generation
After every migration push, regenerate TypeScript types:
```bash
npm run gen:types
```

Commit the updated `src/types/database.types.ts` alongside the migration file.

### Edge function deployment
```bash
npx supabase functions deploy google-oauth-initiate
npx supabase functions deploy google-oauth-callback
npx supabase functions deploy gmail-collector
```

**Gotcha:** Deploy order matters when a migration changes a table that an edge function queries. Always apply the migration before deploying the function.

---

## Netlify

### Site creation
**Date:** 2026-06-17  
**Platform:** app.netlify.com

1. Connected the GitHub repo (BiG-Impact-Group/gmail-knowledge-collector).
2. **Build command:** `npm run build`
3. **Publish directory:** `dist`
4. **Branch to deploy:** `main` (the release branch; `test` is the integration branch and is not auto-deployed).

### Environment variables
**Platform:** Site settings → Environment variables

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL (safe — no secret) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key (safe — RLS enforces access) |

**Gotcha:** `VITE_` prefix is required for Vite to expose variables to the browser bundle. Without it, `import.meta.env.VITE_*` is undefined at runtime.

---

## Local development notes

1. Copy `.env.example` to `.env` and fill in the values from Supabase → Project Settings → API.
2. `.env` is gitignored — never commit it.
3. `npm run dev` starts the Vite dev server at `http://localhost:5173`.
4. The Google OAuth redirect URI for local dev must point to the Supabase edge function, not localhost. The callback then redirects back to `http://localhost:5173/accounts`. Ensure `http://localhost:5173` is in Supabase's Redirect URLs list.
