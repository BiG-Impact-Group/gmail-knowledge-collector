import { render, screen } from '@testing-library/react'
import MessageDetail from './MessageDetail'
import type { Message } from '@/services/messages.service'

const baseMessage: Message = {
  id: '1',
  connected_account_id: 'acc1',
  user_id: 'u1',
  gmail_message_id: 'gm1',
  thread_id: null,
  from_address: 'sender@example.com',
  to_addresses: 'me@example.com',
  subject: 'Test Subject',
  snippet: 'Test snippet',
  internal_date: new Date().toISOString(),
  body_text: null,
  body_html: null,
  label_ids: null,
  fetched_at: new Date().toISOString(),
}

describe('MessageDetail', () => {
  it('shows select prompt when no message', () => {
    render(<MessageDetail message={null} isLoading={false} />)
    expect(screen.getByText(/select a message/i)).toBeInTheDocument()
  })

  it('renders subject and from when message provided', () => {
    render(<MessageDetail message={baseMessage} isLoading={false} />)
    expect(screen.getByText('Test Subject')).toBeInTheDocument()
    expect(screen.getByText(/sender@example.com/)).toBeInTheDocument()
  })

  it('renders iframe for HTML body', () => {
    const msg = { ...baseMessage, body_html: '<p>Hello</p>' }
    render(<MessageDetail message={msg} isLoading={false} />)
    expect(screen.getByTitle('Test Subject')).toBeInTheDocument()
  })

  it('renders pre for text body', () => {
    const msg = { ...baseMessage, body_text: 'Plain text email' }
    render(<MessageDetail message={msg} isLoading={false} />)
    expect(screen.getByText('Plain text email')).toBeInTheDocument()
  })

  it('renders no content message when body is empty', () => {
    render(<MessageDetail message={baseMessage} isLoading={false} />)
    expect(screen.getByText(/no content available/i)).toBeInTheDocument()
  })
})
