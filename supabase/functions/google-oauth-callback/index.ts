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
  return atob(padded)
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
  } catch {
    return new Response('Invalid or expired state. Please try again.', { status: 400 })
  }

  const tokenRes = await fetch(TOKEN_URL, {
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

  if (!tokenRes.ok) {
    return new Response('Token exchange failed', { status: 502 })
  }

  const tokens = await tokenRes.json() as {
    refresh_token?: string
    access_token: string
    id_token: string
  }

  if (!tokens.refresh_token) {
    return new Response('No refresh token returned. Revoke access in Google and try again.', { status: 400 })
  }

  const emailAddress = extractEmailFromIdToken(tokens.id_token)
  const userId = statePayload.user_id

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const { data: account, error: upsertError } = await supabaseAdmin
    .from('connected_accounts')
    .upsert({
      user_id: userId,
      provider: 'google',
      email_address: emailAddress,
      status: 'active',
      granted_scopes: 'https://www.googleapis.com/auth/gmail.readonly',
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,email_address',
      ignoreDuplicates: false,
    })
    .select('id')
    .single()

  if (upsertError || !account) {
    console.error('Upsert error:', upsertError)
    return new Response('Failed to save account', { status: 500 })
  }

  // Store refresh token in Vault keyed by account id
  const existingSecretId = await supabaseAdmin
    .rpc('get_vault_secret_id', { secret_name: account.id })
    .then((r) => r.data as string | null)

  if (existingSecretId) {
    await supabaseAdmin.rpc('vault_update_secret', {
      secret_id: existingSecretId,
      new_secret: tokens.refresh_token,
    })
  } else {
    await supabaseAdmin.rpc('vault_create_secret', {
      secret: tokens.refresh_token,
      name: account.id,
      description: `OAuth refresh token for ${emailAddress}`,
    })
  }

  // access_token is ephemeral — never stored
  return Response.redirect(`${siteUrl}/accounts`, 302)
})
