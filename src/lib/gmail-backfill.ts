const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

export function buildBackfillQuery(after: string, pageToken?: string): string {
  const params = new URLSearchParams({ maxResults: '200', q: `after:${after}` })
  if (pageToken) params.set('pageToken', pageToken)
  return `${GMAIL_API}/users/me/messages?${params}`
}

export function shouldStartBackfill(account: { backfill_start_history_id: string | null }): boolean {
  return account.backfill_start_history_id === null
}

export function isBackfillComplete(nextPageToken: string | null | undefined): boolean {
  return !nextPageToken
}
