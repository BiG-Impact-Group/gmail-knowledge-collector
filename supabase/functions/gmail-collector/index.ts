import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

interface GmailMessage {
  id: string
  threadId: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: GmailPart[]
    mimeType?: string
  }
  snippet?: string
  internalDate?: string
  labelIds?: string[]
}

interface GmailPart {
  mimeType: string
  body?: { data?: string }
  parts?: GmailPart[]
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
  const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function extractBody(payload: GmailMessage['payload']): { text: string | null; html: string | null } {
  if (!payload) return { text: null, html: null }

  function findParts(parts: GmailPart[] | undefined, mimeType: string): string | null {
    if (!parts) return null
    for (const part of parts) {
      if (part.mimeType === mimeType && part.body?.data) {
        return base64urlDecode(part.body.data)
      }
      const nested = findParts(part.parts, mimeType)
      if (nested) return nested
    }
    return null
  }

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return { text: base64urlDecode(payload.body.data), html: null }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return { text: null, html: base64urlDecode(payload.body.data) }
  }

  const html = findParts(payload.parts, 'text/html')
  const text = findParts(payload.parts, 'text/plain')
  return { html, text }
}

function getHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error('token_refresh_failed'), {
      tokenError: (err as Record<string, string>).error,
    })
  }
  const data = await res.json() as { access_token: string }
  return data.access_token
}

async function fetchFullMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const res = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch message ${messageId}`)
  return res.json()
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET')!
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('connected_accounts')
    .select('id, user_id, email_address, sync_cursor')
    .eq('status', 'active')

  if (accountsError) {
    return Response.json({ error: 'Failed to fetch accounts' }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const account of (accounts ?? [])) {
    try {
      const { data: refreshToken } = await supabaseAdmin
        .rpc('get_vault_secret', { secret_name: account.id })

      if (!refreshToken) {
        console.error(`No vault secret for account ${account.id}`)
        errors++
        continue
      }

      let accessToken: string
      try {
        accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken as string)
      } catch (err: unknown) {
        const tokenErr = err as { tokenError?: string }
        if (tokenErr.tokenError === 'invalid_grant' || tokenErr.tokenError === 'token_revoked') {
          await supabaseAdmin
            .from('connected_accounts')
            .update({ status: 'error', updated_at: new Date().toISOString() })
            .eq('id', account.id)
        }
        errors++
        continue
      }

      let messageIds: string[] = []
      let newCursor: string | null = null

      if (!account.sync_cursor) {
        const res = await fetch(
          `${GMAIL_API}/users/me/messages?maxResults=200`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) { errors++; continue }
        const data = await res.json() as { messages?: Array<{ id: string }> }
        messageIds = (data.messages ?? []).map(m => m.id)
        // messages.list has no historyId — fetch it from profile
        const profileRes = await fetch(
          `${GMAIL_API}/users/me/profile`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (profileRes.ok) {
          const profile = await profileRes.json() as { historyId?: string }
          newCursor = profile.historyId ?? null
        }
      } else {
        const res = await fetch(
          `${GMAIL_API}/users/me/history?startHistoryId=${account.sync_cursor}&historyTypes=messageAdded`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) {
          if (res.status === 404) {
            // Cursor too old — reset so next run does a full resync
            await supabaseAdmin
              .from('connected_accounts')
              .update({ sync_cursor: null, updated_at: new Date().toISOString() })
              .eq('id', account.id)
          }
          errors++
          continue
        }
        const data = await res.json() as {
          history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>
          historyId?: string
        }
        newCursor = data.historyId ?? account.sync_cursor
        messageIds = (data.history ?? [])
          .flatMap(h => h.messagesAdded ?? [])
          .map(m => m.message.id)
      }

      for (const msgId of messageIds) {
        try {
          const msg = await fetchFullMessage(accessToken, msgId)
          const headers = msg.payload?.headers
          const { text, html } = extractBody(msg.payload)

          await supabaseAdmin.from('messages').upsert({
            connected_account_id: account.id,
            user_id: account.user_id,
            gmail_message_id: msg.id,
            thread_id: msg.threadId ?? null,
            from_address: getHeader(headers, 'from'),
            to_addresses: getHeader(headers, 'to'),
            subject: getHeader(headers, 'subject'),
            snippet: msg.snippet ?? null,
            internal_date: msg.internalDate
              ? new Date(parseInt(msg.internalDate)).toISOString()
              : null,
            body_text: text,
            body_html: html,
            label_ids: msg.labelIds ?? null,
          }, { onConflict: 'connected_account_id,gmail_message_id', ignoreDuplicates: true })

          processed++
        } catch {
          // Skip individual message failures
        }
      }

      await supabaseAdmin
        .from('connected_accounts')
        .update({
          sync_cursor: newCursor,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', account.id)

    } catch {
      errors++
    }
  }

  return Response.json({ processed, errors, accounts: accounts?.length ?? 0 })
})
