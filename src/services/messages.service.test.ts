import { getMessages, getMessage } from './messages.service'

const mockRange = jest.fn()
const mockOrder = jest.fn(() => ({ range: mockRange }))
const mockSingle = jest.fn()
const mockEq = jest.fn(() => ({ order: mockOrder, single: mockSingle }))
const mockSelect = jest.fn(() => ({ order: mockOrder, eq: mockEq }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({ select: mockSelect })),
  },
}))

describe('messages.service', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('getMessages', () => {
    it('returns empty array when no messages', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      const result = await getMessages()
      expect(result).toEqual([])
    })

    it('throws when supabase returns error', async () => {
      mockRange.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(getMessages()).rejects.toThrow('DB error')
    })

    it('does not filter by account when no connectedAccountId provided', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await getMessages()
      expect(mockEq).not.toHaveBeenCalledWith('connected_account_id', expect.anything())
    })

    it('filters by connected_account_id when provided', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await getMessages('account-123')
      expect(mockEq).toHaveBeenCalledWith('connected_account_id', 'account-123')
    })

    it('uses default offset 0', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await getMessages()
      expect(mockRange).toHaveBeenCalledWith(0, 199)
    })

    it('uses provided offset for pagination', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      await getMessages(undefined, 200)
      expect(mockRange).toHaveBeenCalledWith(200, 399)
    })

    it('returns empty array when filter matches no messages', async () => {
      mockRange.mockResolvedValue({ data: [], error: null })
      const result = await getMessages('no-such-account')
      expect(result).toEqual([])
    })
  })

  describe('getMessage', () => {
    it('returns null when not found (PGRST116)', async () => {
      mockSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      const result = await getMessage('123')
      expect(result).toBeNull()
    })

    it('throws on non-404 error', async () => {
      mockSingle.mockResolvedValue({ data: null, error: new Error('DB error') })
      await expect(getMessage('123')).rejects.toThrow('DB error')
    })
  })
})
