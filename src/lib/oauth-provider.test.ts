import { resolveCallback, PROVIDER_SCOPES } from './oauth-provider'

describe('resolveCallback', () => {
  it('maps a Drive state to google_drive provider, drive scope, and /documents redirect', () => {
    const result = resolveCallback({ provider: 'google_drive', redirect_path: '/documents' })
    expect(result.provider).toBe('google_drive')
    expect(result.grantedScopes).toBe(PROVIDER_SCOPES.google_drive)
    expect(result.grantedScopes).toContain('drive.readonly')
    expect(result.redirectPath).toBe('/documents')
  })

  it('defaults to google + gmail scope + /accounts when fields are absent (backward compatible)', () => {
    const result = resolveCallback({})
    expect(result.provider).toBe('google')
    expect(result.grantedScopes).toContain('gmail.readonly')
    expect(result.redirectPath).toBe('/accounts')
  })

  it('rejects an unknown provider', () => {
    expect(() => resolveCallback({ provider: 'evil_provider' })).toThrow('invalid_provider')
  })

  it('falls back to /accounts for a redirect_path outside the whitelist', () => {
    const result = resolveCallback({ provider: 'google', redirect_path: 'https://evil.example.com' })
    expect(result.redirectPath).toBe('/accounts')
  })

  it('allows /accounts and /documents but nothing else', () => {
    expect(resolveCallback({ redirect_path: '/accounts' }).redirectPath).toBe('/accounts')
    expect(resolveCallback({ redirect_path: '/documents' }).redirectPath).toBe('/documents')
    expect(resolveCallback({ redirect_path: '/admin' }).redirectPath).toBe('/accounts')
  })
})
