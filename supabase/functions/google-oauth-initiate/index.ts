// CONNECTOR SEAM: This function initiates the OAuth flow for Google.
// A second connector (e.g. Microsoft, Slack) would:
//   1. Define its own AUTH_URL, SCOPES, and REDIRECT_URI
//   2. Implement its own state signing or PKCE mechanism
//   3. Deploy as a separate edge function (e.g. microsoft-oauth-initiate)
// The browser calls accounts.service.ts → initiateOAuth(provider) which routes to the correct function.
// See src/types/connector.ts for the ConnectorConfig interface shape.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ')
const REDIRECT_URI = 'https://ybgtzyutbvwfhgtlmnah.supabase.co/functions/v1/google-oauth-callback'

function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function buildStateJwt(userId: string, stateSecret: string, nonce: string): Promise<string> {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    user_id: userId,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
  })))
  const signingInput = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stateSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(sig)}`
}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const stateSecret = Deno.env.get('STATE_SECRET')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
  }

  const nonce = crypto.randomUUID()
  const state = await buildStateJwt(user.id, stateSecret, nonce)

  // Store nonce server-side so the callback can consume it exactly once (replay protection)
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const { error: nonceErr } = await supabaseAdmin
    .from('oauth_nonces')
    .insert({ nonce, user_id: user.id, expires_at: expiresAt })
  if (nonceErr) {
    console.error('Failed to store OAuth nonce:', nonceErr.message)
    return Response.json({ error: 'Internal error' }, { status: 500, headers: corsHeaders })
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })

  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`
  return Response.json({ url }, { headers: corsHeaders })
})
