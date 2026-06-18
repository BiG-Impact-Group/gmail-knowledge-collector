import { getAccounts } from './accounts.service'

const mockOrder = jest.fn()
const mockSelect = jest.fn(() => ({ order: mockOrder }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFrom = jest.fn((_table: string): any => ({ select: mockSelect }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    functions: { invoke: jest.fn() },
  },
}))

beforeEach(() => {
  mockOrder.mockResolvedValue({ data: [], error: null })
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
})
