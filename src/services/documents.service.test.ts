import { listDocuments, getDocument, initiateGoogleDriveOAuth } from './documents.service'

const mockRange = jest.fn()
const mockOrder = jest.fn(() => ({ range: mockRange }))
const mockSingle = jest.fn()
const mockEq = jest.fn(() => ({ order: mockOrder, single: mockSingle }))
const mockSelect = jest.fn(() => ({ order: mockOrder, eq: mockEq }))
const mockInvoke = jest.fn()

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({ select: mockSelect })),
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
  },
}))

describe('documents.service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('listDocuments', () => {
    it('orders by drive_modified_time DESC NULLS LAST and uses range pagination', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await listDocuments({ page: 0 })
      expect(mockOrder).toHaveBeenCalledWith('drive_modified_time', { ascending: false, nullsFirst: false })
      expect(mockRange).toHaveBeenCalledWith(0, 49)
    })

    it('computes range for page 1', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await listDocuments({ page: 1 })
      expect(mockRange).toHaveBeenCalledWith(50, 99)
    })

    it('filters by connected_account_id when accountId provided', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await listDocuments({ page: 0, accountId: 'acct-1' })
      expect(mockEq).toHaveBeenCalledWith('connected_account_id', 'acct-1')
    })

    it('does not filter by account when accountId omitted', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await listDocuments({ page: 0 })
      expect(mockEq).not.toHaveBeenCalled()
    })

    it('returns documents and hasMore=false when fewer than PAGE_SIZE returned', async () => {
      mockRange.mockResolvedValue({ data: [{ id: 'd1' }], error: null })
      const result = await listDocuments({ page: 0 })
      expect(result.documents).toEqual([{ id: 'd1' }])
      expect(result.hasMore).toBe(false)
    })

    it('returns hasMore=true when a full page of PAGE_SIZE returned', async () => {
      const full = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` }))
      mockRange.mockResolvedValue({ data: full, error: null })
      const result = await listDocuments({ page: 0 })
      expect(result.hasMore).toBe(true)
    })

    it('throws when supabase returns an error', async () => {
      mockRange.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(listDocuments({ page: 0 })).rejects.toThrow('DB error')
    })
  })

  describe('getDocument', () => {
    it('returns null when not found (PGRST116)', async () => {
      mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      expect(await getDocument('123')).toBeNull()
    })

    it('throws on non-404 error', async () => {
      mockSingle.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(getDocument('123')).rejects.toThrow('DB error')
    })

    it('returns the row when found', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'd1', name: 'file' }, error: null })
      expect(await getDocument('d1')).toEqual({ id: 'd1', name: 'file' })
    })
  })

  describe('initiateGoogleDriveOAuth', () => {
    // jsdom 26 makes window.location and location.href non-configurable, so the actual
    // navigation cannot be spied on directly. We assert the observable contract: the right
    // edge function is invoked with the right body, the call resolves to void, and the
    // href assignment line runs without throwing when a URL is returned.

    it('invokes the drive initiate function and resolves to void when a URL is returned', async () => {
      mockInvoke.mockResolvedValue({ data: { url: 'https://accounts.google.com/auth?x=1' }, error: null })
      const result = await initiateGoogleDriveOAuth()
      expect(mockInvoke).toHaveBeenCalledWith('google-drive-oauth-initiate', undefined)
      expect(result).toBeUndefined()
    })

    it('does not throw and resolves to void when no URL is returned', async () => {
      mockInvoke.mockResolvedValue({ data: null, error: null })
      await expect(initiateGoogleDriveOAuth()).resolves.toBeUndefined()
    })

    it('passes reconnect body when reconnecting', async () => {
      mockInvoke.mockResolvedValue({ data: { url: 'https://x' }, error: null })
      await initiateGoogleDriveOAuth({ reconnect: true, accountId: 'acct-9' })
      expect(mockInvoke).toHaveBeenCalledWith('google-drive-oauth-initiate', {
        body: { reconnect: true, accountId: 'acct-9' },
      })
    })

    it('throws when the function returns an error', async () => {
      mockInvoke.mockResolvedValue({ data: null, error: new Error('invoke failed') })
      await expect(initiateGoogleDriveOAuth()).rejects.toThrow('invoke failed')
    })
  })
})
