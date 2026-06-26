import { getAccounts, disconnectAccount, deleteAccount, reconnectAccount } from './accounts.service'

const mockFrom = jest.fn()
const mockInvokeFn = jest.fn()

jest.mock('@/lib/supabase', () => ({
  supabase: {
    get from() { return mockFrom },
    functions: { get invoke() { return mockInvokeFn } },
  },
}))

const mockOrder = jest.fn()
const mockSelect = jest.fn(() => ({ order: mockOrder }))


beforeEach(() => {
  mockFrom.mockImplementation(() => ({ select: mockSelect }))
  mockSelect.mockImplementation(() => ({ order: mockOrder }))
  mockOrder.mockResolvedValue({ data: [], error: null })
  mockInvokeFn.mockResolvedValue({ data: null, error: null })
})


afterEach(() => {
  jest.clearAllMocks()
})

describe('accounts.service', () => {
  it('returns empty array when no accounts', async () => {
    const result = await getAccounts()
    expect(result).toEqual([])
  })

  it('throws when supabase returns error', async () => {
    mockOrder.mockResolvedValue({ data: null, error: new Error('DB error') })
    await expect(getAccounts()).rejects.toThrow('DB error')
  })

  it('queries connected_accounts ordered by created_at desc', async () => {
    await getAccounts()
    expect(mockFrom).toHaveBeenCalledWith('connected_accounts')
    expect(mockSelect).toHaveBeenCalledWith('id, provider, email_address, status, granted_scopes, last_synced_at, created_at, updated_at')
    expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  describe('disconnectAccount', () => {
    it('POSTs to google-account-disconnect with accountId and purgeMessages', async () => {
      await disconnectAccount('account-uuid-123', false)
      expect(mockInvokeFn).toHaveBeenCalledWith('google-account-disconnect', {
        body: { accountId: 'account-uuid-123', purgeMessages: false },
      })
    })

    it('POSTs to google-account-disconnect with purgeMessages=true', async () => {
      await disconnectAccount('account-uuid-123', true)
      expect(mockInvokeFn).toHaveBeenCalledWith('google-account-disconnect', {
        body: { accountId: 'account-uuid-123', purgeMessages: true },
      })
    })

    it('throws when edge function returns error', async () => {
      mockInvokeFn.mockResolvedValue({ data: null, error: new Error('disconnect failed') })
      await expect(disconnectAccount('account-uuid-123', false)).rejects.toThrow('disconnect failed')
    })
  })

  describe('deleteAccount', () => {
    it('POSTs to google-account-delete with accountId', async () => {
      await deleteAccount('account-uuid-456')
      expect(mockInvokeFn).toHaveBeenCalledWith('google-account-delete', {
        body: { accountId: 'account-uuid-456' },
      })
    })

    it('throws when edge function returns error', async () => {
      mockInvokeFn.mockResolvedValue({ data: null, error: new Error('delete failed') })
      await expect(deleteAccount('account-uuid-456')).rejects.toThrow('delete failed')
    })
  })

  describe('reconnectAccount', () => {
    it('POSTs to google-oauth-initiate with reconnect=true and accountId', async () => {
      mockInvokeFn.mockResolvedValue({ data: { url: 'https://accounts.google.com/oauth' }, error: null })
      await reconnectAccount('account-uuid-789')
      expect(mockInvokeFn).toHaveBeenCalledWith('google-oauth-initiate', {
        body: { reconnect: true, accountId: 'account-uuid-789' },
      })
    })

    it('throws when edge function returns error', async () => {
      mockInvokeFn.mockResolvedValue({ data: null, error: new Error('initiate failed') })
      await expect(reconnectAccount('account-uuid-789')).rejects.toThrow('initiate failed')
    })
  })
})
