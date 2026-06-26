import { readFileSync } from 'fs'
import { join } from 'path'

// Edge functions run under Deno and cannot be imported into Jest. These regression tests
// assert — at the source level — that each collector restricts its account query to its own
// provider, so neither collector ever grabs the other provider's refresh token (Codex #2).

const fnDir = join(__dirname, '..', '..', 'supabase', 'functions')

function readFn(name: string): string {
  return readFileSync(join(fnDir, name, 'index.ts'), 'utf8')
}

describe('collector account queries are provider-scoped', () => {
  it('gmail-collector restricts to provider = google', () => {
    const src = readFn('gmail-collector')
    expect(src).toMatch(/\.eq\(\s*['"]provider['"]\s*,\s*['"]google['"]\s*\)/)
  })

  it('google-drive-collector restricts to provider = google_drive', () => {
    const src = readFn('google-drive-collector')
    expect(src).toMatch(/\.eq\(\s*['"]provider['"]\s*,\s*['"]google_drive['"]\s*\)/)
  })

  it('google-drive-collector never writes documents via a direct .from(...).upsert()', () => {
    const src = readFn('google-drive-collector')
    // Strip line comments so the documentation banner doesn't trip the assertion.
    const code = src
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    // All document writes must go through the advisory-locked RPCs.
    expect(code).not.toMatch(/\.from\(\s*['"]documents['"]\s*\)/)
    expect(code).not.toMatch(/\.upsert\(/)
    expect(code).toContain('collect_account_documents')
  })
})
