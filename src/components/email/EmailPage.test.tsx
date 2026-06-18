import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmailPage from './EmailPage'

const mockOrder = jest.fn(() => Promise.resolve({ data: [], error: null }))
const mockSingle = jest.fn(() => Promise.resolve({ data: null, error: null }))

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: mockOrder,
        eq: jest.fn(() => ({ single: mockSingle })),
      })),
    })),
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
})
