// CONNECTOR SEAM: This function handles the OAuth callback for Google.
// A second connector would implement its own callback with provider-specific token exchange.
// The callback URL must be registered with the provider's OAuth client configuration.
// Key invariants that ALL connectors must honour:
//   - Store refresh tokens in Supabase Vault only (never return to browser)
//   - Mark connected_account status 'error' before vault write, 'active' only on success
//   - Never log token values — log only error codes
//   - Every abort path after token exchange must attempt to revoke the new token

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

// Provider-driven scope mapping. The callback records granted_scopes per provider so a
// Drive connection records drive.readonly rather than the hardcoded Gmail scope string.
const PROVIDER_SCOPES: Record<string, string> = {
  google:       'openid email https://www.googleapis.com/auth/gmail.readonly',
  google_drive: 'openid email https://www.googleapis.com/auth/drive.readonly',
}

// Open-redirect guard: only redirect to known app paths even though state is HMAC-signed.
const ALLOWED_REDIRECTS = new Set(['/accounts', '/documents'])

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
  reconnect_account_id?: string
  provider?: string        // 'google' | 'google_drive' — defaults to 'google'
  redirect_path?: string   // e.g. '/documents' — defaults to '/accounts'
  expected_lifecycle_version?: number  // signed at reconnect-initiate; guards the reconnect update
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

async function fetchEmailFromUserinfo(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Userinfo failed: ${res.status}`)
  const data = await res.json() as { email?: string; email_verified?: boolean }
  if (!data.email_verified) throw new Error('Email not verified')
  if (!data.email) throw new Error('No email in userinfo')
  return data.email
}

/**
 * Best-effort token revoke.
 * Returns true if the token is definitely gone (revoked or already invalid 4xx).
 * Returns false if the revoke failed transiently (5xx or network error).
 */
async function tryRevokeToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    })
    if (res.ok) return true
    // 4xx = token already invalid/dead — treat as terminal success
    if (res.status >= 400 && res.status < 500) return true
    // 5xx = Google-side error — caller should park the token for manual cleanup
    console.error('Best-effort revoke got 5xx:', res.status)
    return false
  } catch (e) {
    console.error('Best-effort revoke network error:', (e as Error).message)
    return false
  }
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

  // Validate the provider before writing any unconstrained row.
  const provider = statePayload.provider ?? 'google'
  if (!(provider in PROVIDER_SCOPES)) {
    console.error('Unknown provider in state JWT')
    return new Response('Invalid provider. Please try again.', { status: 400 })
  }
  const grantedScopes = PROVIDER_SCOPES[provider]

  // Whitelist the post-success redirect path (open-redirect guard).
  const requestedRedirect = statePayload.redirect_path ?? '/accounts'
  const redirectPath = ALLOWED_REDIRECTS.has(requestedRedirect) ? requestedRedirect : '/accounts'

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  // Consume nonce atomically — a second request with the same state is rejected
  const { data: consumed, error: nonceErr } = await supabaseAdmin
    .from('oauth_nonces')
    .delete()
    .eq('nonce', statePayload.nonce)
    .eq('user_id', statePayload.user_id)
    .gt('expires_at', new Date().toISOString())
    .select('nonce')
  if (nonceErr || !consumed?.length) {
    console.error('Nonce validation failed (already used, expired, or not found)')
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
  }

  if (!tokens.refresh_token) {
    console.error('No refresh_token in response. Tokens keys:', Object.keys(tokens))
    // No refresh token to store, but the access token is a live grant — revoke it so we
    // never abort after token exchange while leaving a usable credential active.
    if (tokens.access_token) await tryRevokeToken(tokens.access_token)
    return new Response('No refresh token returned. Revoke access at myaccount.google.com/permissions and try again.', { status: 400 })
  }

  // All post-token-exchange steps are wrapped in try/catch.
  // On any failure, attempt to revoke the newly issued token before returning error.
  try {
    let emailAddress: string
    try {
      emailAddress = await fetchEmailFromUserinfo(tokens.access_token)
    } catch (e) {
      console.error('Failed to fetch email from userinfo:', e)
      throw new Error('fetch_userinfo_failed')
    }

    const userId = statePayload.user_id
    const reconnectAccountId = statePayload.reconnect_account_id

    if (reconnectAccountId) {
      // === RECONNECT PATH ===
      // Fetch the existing account to verify email match and get current state
      const { data: existingAccount, error: fetchErr } = await supabaseAdmin
        .from('connected_accounts')
        .select('id, email_address, lifecycle_version, provider')
        .eq('id', reconnectAccountId)
        .eq('user_id', userId)
        .single()

      if (fetchErr || !existingAccount) {
        console.error('Reconnect: account not found or not owned')
        throw new Error('account_not_found')
      }

      // Provider must match: a Gmail reconnect must not overwrite a Drive account's
      // tokens/scopes or vice-versa.
      if (existingAccount.provider !== provider) {
        console.error('Reconnect: provider mismatch between state JWT and existing account')
        throw new Error('provider_mismatch')
      }

      // Email must match the account being reconnected
      if (existingAccount.email_address !== emailAddress) {
        console.error('Reconnect: email mismatch — expected account email, got different address')
        throw new Error('email_mismatch')
      }

      // Guard against the lifecycle_version captured at INITIATE time (signed into state),
      // falling back to the current row version for older states without the field. This
      // detects a disconnect/delete that ran ANY time between initiation and this callback,
      // not just one racing this transaction. A mismatch → 0 rows → concurrent_delete (token revoked).
      const guardVersion = statePayload.expected_lifecycle_version ?? existingAccount.lifecycle_version
      const { data: updatedRows, error: updateErr } = await supabaseAdmin
        .from('connected_accounts')
        .update({
          status: 'error', // will be set active after vault write
          granted_scopes: grantedScopes,
          backfill_complete: false,
          backfill_page_token: null,
          backfill_start_history_id: null,
          sync_cursor: null,
          lifecycle_version: guardVersion + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', reconnectAccountId)
        .eq('user_id', userId)
        .eq('lifecycle_version', guardVersion)
        .select('id')

      if (updateErr) {
        console.error('Reconnect update error:', JSON.stringify(updateErr))
        throw new Error('update_failed')
      }

      if (!updatedRows || updatedRows.length === 0) {
        // Row was deleted by a concurrent lifecycle_delete
        console.error('Reconnect: row deleted concurrently — 0 rows updated')
        throw new Error('concurrent_delete')
      }

      const account = updatedRows[0]

      // Write new refresh token to Vault
      const { data: existingSecretId, error: vaultLookupError } = await supabaseAdmin
        .rpc('get_vault_secret_id', { secret_name: account.id })

      if (vaultLookupError) {
        console.error('Vault lookup error:', JSON.stringify(vaultLookupError))
        throw new Error('vault_lookup_failed')
      }

      if (existingSecretId) {
        const { error: updateVaultErr } = await supabaseAdmin.rpc('vault_update_secret', {
          secret_id: existingSecretId,
          new_secret: tokens.refresh_token,
        })
        if (updateVaultErr) {
          console.error('Vault update error:', JSON.stringify(updateVaultErr))
          throw new Error('vault_update_failed')
        }
      } else {
        const { error: createErr } = await supabaseAdmin.rpc('vault_create_secret', {
          secret: tokens.refresh_token,
          name: account.id,
          description: `OAuth refresh token for ${emailAddress}`,
        })
        if (createErr) {
          console.error('Vault create error:', JSON.stringify(createErr))
          throw new Error('vault_create_failed')
        }
      }

      // Vault write succeeded — mark account active, GUARDED on the version we set above.
      // If a disconnect/delete landed after our guarded update (bumping the version again),
      // this matches 0 rows → abort + revoke, so we never resurrect a just-revoked account.
      const { data: activatedRows, error: activateErr } = await supabaseAdmin
        .from('connected_accounts')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', account.id)
        .eq('lifecycle_version', guardVersion + 1)
        .select('id')
      if (activateErr || !activatedRows?.length) {
        console.error('Mark active failed (reconnect):', JSON.stringify(activateErr))
        throw new Error('mark_active_failed')
      }

    } else {
      // === NEW CONNECTION PATH ===
      // Check if an existing row exists (error/revoked) so we can reset backfill state on reactivation
      const { data: existingRow } = await supabaseAdmin
        .from('connected_accounts')
        .select('id, status, lifecycle_version')
        .eq('user_id', userId)
        .eq('provider', provider)
        .eq('email_address', emailAddress)
        .maybeSingle()

      const isReactivation = existingRow?.status === 'error' || existingRow?.status === 'revoked'

      // Save account as 'error' first; update to 'active' only after vault write succeeds
      const { data: account, error: upsertError } = await supabaseAdmin
        .from('connected_accounts')
        .upsert({
          user_id: userId,
          provider,
          email_address: emailAddress,
          status: 'error',
          granted_scopes: grantedScopes,
          updated_at: new Date().toISOString(),
          // Reset backfill state when reactivating an error/revoked account so the
          // collector doesn't call history?startHistoryId=null after seeing backfill_complete=true
          ...(isReactivation ? {
            backfill_complete: false,
            sync_cursor: null,
            backfill_page_token: null,
            backfill_start_history_id: null,
            lifecycle_version: (existingRow.lifecycle_version ?? 0) + 1,
          } : {}),
        }, {
          onConflict: 'user_id,provider,email_address',
          ignoreDuplicates: false,
        })
        .select('id, lifecycle_version')
        .single()

      if (upsertError || !account) {
        console.error('Upsert error:', JSON.stringify(upsertError))
        throw new Error('upsert_failed')
      }
      const upsertVersion = account.lifecycle_version

      // Store refresh token in Vault keyed by account id
      const { data: existingSecretId, error: vaultLookupError } = await supabaseAdmin
        .rpc('get_vault_secret_id', { secret_name: account.id })

      if (vaultLookupError) {
        console.error('Vault lookup error:', JSON.stringify(vaultLookupError))
        throw new Error('vault_lookup_failed')
      }

      if (existingSecretId) {
        const { error: updateErr } = await supabaseAdmin.rpc('vault_update_secret', {
          secret_id: existingSecretId,
          new_secret: tokens.refresh_token,
        })
        if (updateErr) {
          console.error('Vault update error:', JSON.stringify(updateErr))
          throw new Error('vault_update_failed')
        }
      } else {
        const { error: createErr } = await supabaseAdmin.rpc('vault_create_secret', {
          secret: tokens.refresh_token,
          name: account.id,
          description: `OAuth refresh token for ${emailAddress}`,
        })
        if (createErr) {
          console.error('Vault create error:', JSON.stringify(createErr))
          throw new Error('vault_create_failed')
        }
      }

      // Vault write succeeded — mark account active, GUARDED on the version from the upsert.
      // A disconnect/delete landing in this window bumps lifecycle_version → 0 rows → abort + revoke.
      const { data: activatedRows, error: activateErr } = await supabaseAdmin
        .from('connected_accounts')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', account.id)
        .eq('lifecycle_version', upsertVersion)
        .select('id')
      if (activateErr || !activatedRows?.length) {
        console.error('Mark active failed (new connection):', JSON.stringify(activateErr))
        throw new Error('mark_active_failed')
      }
    }

  } catch (e) {
    // Best-effort revoke on any post-exchange abort path
    const revoked = await tryRevokeToken(tokens.refresh_token)
    const msg = (e as Error).message
    console.error('Post-exchange step failed, revoke attempted:', msg)

    if (!revoked) {
      // 5xx or network error — park the token in Vault so it can be cleaned up manually
      const parkKey = `revoke_pending_${crypto.randomUUID()}`
      const { error: parkErr } = await supabaseAdmin.rpc('vault_create_secret', {
        secret: tokens.refresh_token,
        name: parkKey,
        description: `Pending revoke — token issued during failed OAuth callback (${msg})`,
      })
      if (parkErr) {
        console.error('Failed to park unrevoked token:', JSON.stringify(parkErr))
      } else {
        console.error('Parked unrevoked token under Vault key:', parkKey)
      }
    }

    if (msg === 'email_mismatch') {
      return new Response('Email mismatch: reconnect must use the same Google account.', { status: 400 })
    }
    if (msg === 'provider_mismatch') {
      return new Response('Provider mismatch: reconnect must use the same provider as the original connection.', { status: 400 })
    }
    if (msg === 'concurrent_delete') {
      return new Response('Account was deleted concurrently. Please reconnect from scratch.', { status: 400 })
    }
    return new Response('OAuth callback failed. Please try again.', { status: 500 })
  }

  // access_token is ephemeral — never stored
  return Response.redirect(`${siteUrl}${redirectPath}`, 302)
})
