// google-account-delete: Revoke Google OAuth, delete Vault secret, delete account row.
// Cascade deletes messages via FK ON DELETE CASCADE.
// Uses lifecycle_delete RPC for atomic delete with reconnect race detection.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** Revoke a Google token via POST body (not query string — avoids token in logs) */
async function revokeGoogleToken(token: string): Promise<{ ok: boolean; terminal: boolean }> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
    if (res.ok) return { ok: true, terminal: false }
    // 400/401/403 = token already dead — treat as success
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: true, terminal: true }
    }
    // 5xx = Google-side error — block cleanup
    return { ok: false, terminal: false }
  } catch {
    return { ok: false, terminal: false }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
  }

  // Verify JWT
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
  }

  // Parse and validate body
  let accountId: string
  try {
    const body = await req.json() as { accountId?: unknown }
    if (typeof body.accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.accountId)) {
      return Response.json({ error: 'accountId must be a UUID' }, { status: 400, headers: corsHeaders })
    }
    accountId = body.accountId
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders })
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  // Fetch account — verify ownership
  const { data: account, error: fetchErr } = await supabaseAdmin
    .from('connected_accounts')
    .select('id, user_id, lifecycle_version')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single()

  if (fetchErr || !account) {
    return Response.json({ error: 'Account not found' }, { status: 404, headers: corsHeaders })
  }

  // Fetch refresh token from Vault
  const { data: refreshToken, error: vaultErr } = await supabaseAdmin
    .rpc('get_vault_secret', { secret_name: account.id })

  if (vaultErr) {
    console.error('Vault fetch error:', JSON.stringify(vaultErr))
    return Response.json({ error: 'Failed to access vault' }, { status: 502, headers: corsHeaders })
  }
  if (!refreshToken) {
    // No Vault secret — we cannot verify the Google grant is dead. Require manual revoke.
    return Response.json(
      { error: 'no_vault_token', message: 'Revoke access at myaccount.google.com/permissions, then retry.' },
      { status: 502, headers: corsHeaders },
    )
  }
  const tokenToRevoke: string = refreshToken

  // Revoke Google token — on 5xx/network error, abort (do NOT delete)
  const revoke = await revokeGoogleToken(tokenToRevoke)
  if (!revoke.ok) {
    return Response.json({ error: 'Google revoke failed. Please try again.' }, { status: 502, headers: corsHeaders })
  }

  // Call lifecycle_delete RPC — atomic with version check, cascades messages
  const { data: deleted, error: rpcErr } = await supabaseAdmin
    .rpc('lifecycle_delete', {
      p_account_id: account.id,
      p_user_id: user.id,
      p_expected_version: account.lifecycle_version,
    })

  if (rpcErr) {
    console.error('lifecycle_delete RPC error:', JSON.stringify(rpcErr))
    return Response.json({ error: 'Delete failed' }, { status: 500, headers: corsHeaders })
  }

  if (!deleted) {
    // Version mismatch — reconnect raced. Do NOT delete Vault secret: reconnect stored a new token there.
    return Response.json(
      { error: 'reconnect_in_progress' },
      { status: 409, headers: corsHeaders },
    )
  }

  // RPC succeeded — safe to delete Vault secret (reconnect cannot write a new token anymore)
  const { error: vaultDeleteErr } = await supabaseAdmin
    .rpc('vault_delete_secret', { secret_name: account.id })
  if (vaultDeleteErr) {
    console.error('Vault delete error:', JSON.stringify(vaultDeleteErr))
    return Response.json({ error: 'Failed to delete vault secret' }, { status: 500, headers: corsHeaders })
  }

  return Response.json({ success: true }, { headers: corsHeaders })
})
