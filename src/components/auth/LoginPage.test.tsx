import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LoginPage from './LoginPage'

const mockSignInWithOAuth = jest.fn()
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { signInWithOAuth: (opts: unknown) => mockSignInWithOAuth(opts) },
  },
}))

function renderLoginPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('LoginPage', () => {
  it('renders the Google sign-in button', () => {
    renderLoginPage()
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument()
  })

  it('calls signInWithOAuth with google provider on click', async () => {
    mockSignInWithOAuth.mockResolvedValue({ error: null })
    renderLoginPage()
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }))
    await waitFor(() => {
      expect(mockSignInWithOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'google' }),
      )
    })
  })

  it('shows error message if signInWithOAuth returns an error', async () => {
    mockSignInWithOAuth.mockResolvedValue({ error: { message: 'OAuth error' } })
    renderLoginPage()
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('OAuth error')
    })
  })

  it('disables the button while loading', async () => {
    mockSignInWithOAuth.mockReturnValue(new Promise(() => {}))
    renderLoginPage()
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /redirecting/i })).toBeDisabled()
    })
  })
})
