import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmailPage from './EmailPage'

// Per-table mock chains so accounts (terminal: order) and messages (terminal: range) don't conflict.
const mockAccountsOrder = jest.fn(() => Promise.resolve({ data: [], error: null }))
const mockMessagesRange = jest.fn(() => Promise.resolve({ data: [], error: null }))
const mockMessagesOrder = jest.fn(() => ({ range: mockMessagesRange }))
const mockMessagesSingle = jest.fn(() => Promise.resolve({ data: null, error: null }))
const mockMessagesEq = jest.fn(() => ({ order: mockMessagesOrder, single: mockMessagesSingle }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'connected_accounts') {
        return { select: jest.fn(() => ({ order: mockAccountsOrder })) }
      }
      return {
        select: jest.fn(() => ({
          order: mockMessagesOrder,
          eq: mockMessagesEq,
        })),
      }
    }),
  },
}))

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}))

function renderEmailPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('EmailPage', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders header with Emails title', () => {
    renderEmailPage()
    expect(screen.getByText('Emails')).toBeInTheDocument()
  })

  it('renders empty state when no accounts', async () => {
    renderEmailPage()
    expect(await screen.findByText(/connect a gmail account/i)).toBeInTheDocument()
  })

  it('does not show account filter when only one account', async () => {
    mockAccountsOrder.mockResolvedValueOnce({
      data: [{ id: 'a1', email_address: 'user@example.com' }],
      error: null,
    })
    renderEmailPage()
    // Single account — no dropdown needed
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('shows account filter when two accounts are connected', async () => {
    mockAccountsOrder.mockResolvedValueOnce({
      data: [
        { id: 'a1', email_address: 'alice@example.com' },
        { id: 'a2', email_address: 'bob@example.com' },
      ],
      error: null,
    })
    renderEmailPage()
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    expect(await screen.findByText('bob@example.com')).toBeInTheDocument()
  })
})
