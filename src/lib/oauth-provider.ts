// Pure provider/scope/redirect mapping logic shared (by duplication) with the
// google-oauth-callback edge function. Unit-tested under Jest; the edge function
// inlines the same constants because it cannot import from src/.

export const PROVIDER_SCOPES: Record<string, string> = {
  google: 'openid email https://www.googleapis.com/auth/gmail.readonly',
  google_drive: 'openid email https://www.googleapis.com/auth/drive.readonly',
}

export const ALLOWED_REDIRECTS = new Set(['/accounts', '/documents'])

export interface CallbackState {
  provider?: string
  redirect_path?: string
}

export interface ResolvedCallback {
  provider: string
  grantedScopes: string
  redirectPath: string
}

// Resolve provider, scopes, and redirect path from a (verified) state payload.
// Throws 'invalid_provider' for an unknown provider. Redirect path outside the
// whitelist falls back to '/accounts'.
export function resolveCallback(state: CallbackState): ResolvedCallback {
  const provider = state.provider ?? 'google'
  if (!(provider in PROVIDER_SCOPES)) {
    throw new Error('invalid_provider')
  }
  const grantedScopes = PROVIDER_SCOPES[provider]
  const requested = state.redirect_path ?? '/accounts'
  const redirectPath = ALLOWED_REDIRECTS.has(requested) ? requested : '/accounts'
  return { provider, grantedScopes, redirectPath }
}
