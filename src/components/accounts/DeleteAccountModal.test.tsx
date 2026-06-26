import { render, screen, fireEvent } from '@testing-library/react'
import DeleteAccountModal from './DeleteAccountModal'

describe('DeleteAccountModal', () => {
  const email = 'test@example.com'
  const onConfirm = jest.fn()
  const onCancel = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders warning copy about permanent deletion', () => {
    render(
      <DeleteAccountModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText(/permanently remove/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
  })

  it('shows the account email address in the heading', () => {
    render(
      <DeleteAccountModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('heading')).toHaveTextContent(email)
  })

  it('calls onConfirm when Delete permanently is clicked', () => {
    render(
      <DeleteAccountModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('calls onCancel when Cancel is clicked without calling onConfirm', () => {
    render(
      <DeleteAccountModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables buttons while loading', () => {
    render(
      <DeleteAccountModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading
      />,
    )
    expect(screen.getByRole('button', { name: /deleting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
  })
})
