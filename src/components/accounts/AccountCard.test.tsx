import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AccountCard from './AccountCard'
import type { ConnectedAccount } from '@/services/accounts.service'

const mockReconnectAccount = jest.fn()
const mockInitiateGoogleDriveOAuth = jest.fn()

jest.mock('@/services/accounts.service', () => ({
  reconnectAccount: (...args: unknown[]) => mockReconnectAccount(...args),
}))
jest.mock('@/services/documents.service', () => ({
  initiateGoogleDriveOAuth: (...args: unknown[]) => mockInitiateGoogleDriveOAuth(...args),
}))
jest.mock('@/hooks/useAccounts', () => ({
  useDisconnectAccount: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteAccount: () => ({ mutate: jest.fn(), isPending: false }),
}))

function makeAccount(overrides: Partial<ConnectedAccount>): ConnectedAccount {
  return {
    id: 'acct-1',
    provider: 'google',
    email_address: 'user@example.com',
    status: 'active',
    granted_scopes: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as ConnectedAccount
}

beforeEach(() => jest.clearAllMocks())

describe('AccountCard', () => {
  it('renders the Google label for a Gmail account', () => {
    render(<AccountCard account={makeAccount({ provider: 'google' })} />)
    expect(screen.getByText('Google')).toBeInTheDocument()
  })

  it('renders the Google Drive label for a Drive account', () => {
    render(<AccountCard account={makeAccount({ provider: 'google_drive' })} />)
    expect(screen.getByText('Google Drive')).toBeInTheDocument()
  })

  it('shows Disconnect and Delete for an active account', () => {
    render(<AccountCard account={makeAccount({ status: 'active' })} />)
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('reconnect on a google account calls the Gmail reconnect path', async () => {
    mockReconnectAccount.mockResolvedValue(undefined)
    render(<AccountCard account={makeAccount({ provider: 'google', status: 'error' })} />)
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    await waitFor(() => expect(mockReconnectAccount).toHaveBeenCalledWith('acct-1'))
    expect(mockInitiateGoogleDriveOAuth).not.toHaveBeenCalled()
  })

  it('reconnect on a google_drive account calls the Drive initiate path', async () => {
    mockInitiateGoogleDriveOAuth.mockResolvedValue(undefined)
    render(<AccountCard account={makeAccount({ id: 'acct-2', provider: 'google_drive', status: 'revoked' })} />)
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }))
    await waitFor(() =>
      expect(mockInitiateGoogleDriveOAuth).toHaveBeenCalledWith({ reconnect: true, accountId: 'acct-2' }),
    )
    expect(mockReconnectAccount).not.toHaveBeenCalled()
  })
})
