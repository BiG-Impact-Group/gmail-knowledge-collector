// CONNECTOR SEAM: This function handles the OAuth callback for Google.
// A second connector would implement its own callback with provider-specific token exchange.
// The callback URL must be registered with the provider's OAuth client configuration.
// Key invariants that ALL connectors must honour:
//   - Store refresh tokens in Supabase Vault only (never return to browser)
//   - Mark connected_account status 'error' before vault write, 'active' only on success
//   - Never log token values — log only error codes

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

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
    return new Response('No refresh token returned. Revoke access at myaccount.google.com/permissions and try again.', { status: 400 })
  }

  let emailAddress: string
  try {
    emailAddress = await fetchEmailFromUserinfo(tokens.access_token)
  } catch (e) {
    console.error('Failed to fetch email from userinfo:', e)
    return new Response('Failed to read account email', { status: 500 })
  }

  const userId = statePayload.user_id

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
