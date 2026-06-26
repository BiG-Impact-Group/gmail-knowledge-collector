import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DocumentsPage from './DocumentsPage'

const mockUseAccounts = jest.fn()
const mockUseDocuments = jest.fn()
const mockUseDocument = jest.fn()

jest.mock('@/hooks/useAccounts', () => ({
  useAccounts: () => mockUseAccounts(),
}))
jest.mock('@/hooks/useDocuments', () => ({
  useDocuments: () => mockUseDocuments(),
  useDocument: () => mockUseDocument(),
}))
// Mock the service so the test does not pull in @/lib/supabase (import.meta.env).
jest.mock('@/services/documents.service', () => ({
  initiateGoogleDriveOAuth: jest.fn(),
}))
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}))

function driveAccount(id = 'acct-1') {
  return { id, provider: 'google_drive', email_address: 'drive@example.com', status: 'active' }
}

function infiniteResult(documents: unknown[]) {
  return {
    data: { pages: [{ documents, hasMore: false }] },
    isLoading: false,
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DocumentsPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUseAccounts.mockReturnValue({ data: [driveAccount()], isLoading: false })
  mockUseDocuments.mockReturnValue(infiniteResult([]))
  mockUseDocument.mockReturnValue({ data: null, isLoading: false })
})

describe('DocumentsPage', () => {
  it('renders the no-Drive-accounts empty state when there are no Drive accounts', () => {
    mockUseAccounts.mockReturnValue({ data: [], isLoading: false })
    renderPage()
    expect(screen.getByText(/no drive accounts connected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connect google drive/i })).toBeInTheDocument()
  })

  it('renders the document list when documents are present', () => {
    mockUseDocuments.mockReturnValue(infiniteResult([
      { id: 'd1', name: 'Report.txt', mime_type: 'text/plain', content_status: 'extracted', drive_modified_time: null, connected_account_id: 'acct-1' },
    ]))
    renderPage()
    expect(screen.getByText('Report.txt')).toBeInTheDocument()
  })

  it('selecting a document renders its detail pane', () => {
    mockUseDocuments.mockReturnValue(infiniteResult([
      { id: 'd1', name: 'Report.txt', mime_type: 'text/plain', content_status: 'extracted', drive_modified_time: null, connected_account_id: 'acct-1' },
    ]))
    mockUseDocument.mockReturnValue({
      data: {
        id: 'd1', name: 'Report.txt', mime_type: 'text/plain', content_status: 'extracted',
        text_content: 'hello body', size_bytes: null, drive_modified_time: null, web_view_link: null,
      },
      isLoading: false,
    })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Report\.txt/ }))
    expect(screen.getByText('hello body')).toBeInTheDocument()
  })

  it('shows the pending message for needs_processing documents', () => {
    mockUseDocument.mockReturnValue({
      data: {
        id: 'd2', name: 'big.docx', mime_type: 'application/pdf', content_status: 'needs_processing',
        text_content: null, size_bytes: 1234, drive_modified_time: null, web_view_link: null,
      },
      isLoading: false,
    })
    renderPage()
    expect(screen.getByText(/content extraction pending/i)).toBeInTheDocument()
  })

  it('renders html-source text_content as plain text, NOT as markup', () => {
    const malicious = '<img src=x onerror=alert(1)><b>bold</b>'
    mockUseDocument.mockReturnValue({
      data: {
        id: 'd3', name: 'page.html', mime_type: 'text/html', content_status: 'extracted',
        text_content: malicious, size_bytes: null, drive_modified_time: null, web_view_link: null,
      },
      isLoading: false,
    })
    const { container } = renderPage()
    // The raw markup must appear as visible text...
    expect(screen.getByText(malicious)).toBeInTheDocument()
    // ...and must NOT have been parsed into real DOM elements.
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })
})
