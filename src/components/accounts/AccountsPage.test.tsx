import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AccountsPage from './AccountsPage'

const mockOrder = jest.fn()
const mockSelect = jest.fn(() => ({ order: mockOrder }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFrom = jest.fn((_table: string): any => ({ select: mockSelect }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { signOut: jest.fn() },
    from: (table: string) => mockFrom(table),
    functions: { invoke: jest.fn() },
  },
}))

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}))

function renderAccountsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const baseAccount = {
  id: '1',
  provider: 'google',
  last_synced_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  granted_scopes: null,
  sync_cursor: null,
  user_id: 'u1',
}

beforeEach(() => {
  mockOrder.mockResolvedValue({ data: [], error: null })
})

afterEach(() => {
  jest.clearAllMocks()
})

describe('AccountsPage', () => {
  it('renders header with Connect Gmail button', () => {
    renderAccountsPage()
    expect(screen.getByRole('button', { name: /connect gmail/i })).toBeInTheDocument()
  })

  it('renders empty state when no accounts', async () => {
    renderAccountsPage()
    expect(await screen.findByText(/no accounts connected/i)).toBeInTheDocument()
  })

  it('renders account card when accounts exist', async () => {
    mockOrder.mockResolvedValue({
      data: [{ ...baseAccount, email_address: 'test@gmail.com', status: 'active' }],
      error: null,
    })
    renderAccountsPage()
    expect(await screen.findByText('test@gmail.com')).toBeInTheDocument()
  })

  it('renders Reconnect button for error-status account', async () => {
    mockOrder.mockResolvedValue({
      data: [{ ...baseAccount, email_address: 'fail@gmail.com', status: 'error' }],
      error: null,
    })
    renderAccountsPage()
    expect(await screen.findByRole('button', { name: /reconnect/i })).toBeInTheDocument()
  })
})
