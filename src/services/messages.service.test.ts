import { getMessages, getMessage } from './messages.service'

const mockRange = jest.fn()
const mockOrder = jest.fn(() => ({ range: mockRange }))
const mockSingle = jest.fn()
const mockEq = jest.fn(() => ({ single: mockSingle }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: mockOrder,
        eq: mockEq,
      })),
    })),
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
