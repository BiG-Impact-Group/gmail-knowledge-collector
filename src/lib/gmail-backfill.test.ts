import { buildBackfillQuery, shouldStartBackfill, isBackfillComplete } from './gmail-backfill'

describe('buildBackfillQuery', () => {
  it('builds URL with after query and maxResults', () => {
    const url = buildBackfillQuery('2025/06/18')
    expect(url).toContain('maxResults=200')
    expect(url).toContain('q=after%3A2025%2F06%2F18')
  })

  it('appends pageToken when provided', () => {
    const url = buildBackfillQuery('2025/06/18', 'tok123')
    expect(url).toContain('pageToken=tok123')
  })

  it('omits pageToken when not provided', () => {
    const url = buildBackfillQuery('2025/06/18')
    expect(url).not.toContain('pageToken')
  })
})

describe('shouldStartBackfill', () => {
  it('returns true when backfill_start_history_id is null', () => {
    expect(shouldStartBackfill({ backfill_start_history_id: null })).toBe(true)
  })

  it('returns false when backfill_start_history_id is set', () => {
    expect(shouldStartBackfill({ backfill_start_history_id: '12345' })).toBe(false)
  })
})

describe('isBackfillComplete', () => {
  it('returns true when nextPageToken is null', () => {
    expect(isBackfillComplete(null)).toBe(true)
  })

  it('returns true when nextPageToken is undefined', () => {
    expect(isBackfillComplete(undefined)).toBe(true)
  })

  it('returns false when nextPageToken has a value', () => {
    expect(isBackfillComplete('nextPage123')).toBe(false)
  })
})
