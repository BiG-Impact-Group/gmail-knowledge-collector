import { render, screen, fireEvent } from '@testing-library/react'
import DisconnectModal from './DisconnectModal'

describe('DisconnectModal', () => {
  const email = 'test@example.com'
  const onConfirm = jest.fn()
  const onCancel = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders both radio options', () => {
    render(
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText(/Keep my collected emails/i)).toBeInTheDocument()
    expect(screen.getByText(/Delete my collected emails/i)).toBeInTheDocument()
  })

  it('shows the account email address in the heading', () => {
    render(
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('heading')).toHaveTextContent(email)
  })

  it('keep option is default selected (purgeMessages=false)', () => {
    render(
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const radios = screen.getAllByRole('radio')
    const keepRadio = radios.find(r => (r as unknown as { value: string }).value === 'keep')
    const purgeRadio = radios.find(r => (r as unknown as { value: string }).value === 'purge')
    expect(keepRadio).toBeChecked()
    expect(purgeRadio).not.toBeChecked()
  })

  it('calls onConfirm with purgeMessages=false when keep is selected and Disconnect clicked', () => {
    render(
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('calls onConfirm with purgeMessages=true when delete option selected', () => {
    render(
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const radios = screen.getAllByRole('radio')
    const purgeRadio = radios.find(r => (r as unknown as { value: string }).value === 'purge')!
    fireEvent.click(purgeRadio)
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('calls onCancel when Cancel is clicked without calling onConfirm', () => {
    render(
      <DisconnectModal
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
      <DisconnectModal
        emailAddress={email}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading
      />,
    )
    expect(screen.getByRole('button', { name: /disconnecting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
  })
})
