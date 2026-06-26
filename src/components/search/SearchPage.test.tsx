import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SearchPage from './SearchPage'
import type { SearchResult } from '@/services/search.service'

const mockMutate = jest.fn()
const mockReset = jest.fn()
let mockState: {
  data?: SearchResult[]
  isPending: boolean
  error: Error | null
}

jest.mock('@/hooks/useSearch', () => ({
  useSearch: () => ({
    mutate: mockMutate,
    data: mockState.data,
    isPending: mockState.isPending,
    error: mockState.error,
    reset: mockReset,
  }),
}))
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}))

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    document_id: 'doc-1',
    document_name: 'Report.txt',
    web_view_link: 'https://drive.google.com/file/d/abc/view',
    content: 'A relevant passage.',
    chunk_index: 0,
    similarity: 0.87,
    ...overrides,
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SearchPage />
    </MemoryRouter>,
  )
}

function submit() {
  const input = screen.getByLabelText(/search your collected email and files/i)
  fireEvent.change(input, { target: { value: 'what is the budget' } })
  fireEvent.click(screen.getByRole('button', { name: /search/i }))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockState = { data: undefined, isPending: false, error: null }
})

describe('SearchPage', () => {
  it('renders the empty/prompt state initially', () => {
    renderPage()
    expect(screen.getByText(/ask a question about your collected email and files/i)).toBeInTheDocument()
  })

  it('renders the loading state while pending', () => {
    mockState = { data: undefined, isPending: true, error: null }
    renderPage()
    // The loading paragraph and the disabled submit button both read "Searching…".
    expect(screen.getAllByText(/searching/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: /searching/i })).toBeDisabled()
  })

  it('renders results as cards with source and passage', () => {
    mockState = { data: [result()], isPending: false, error: null }
    renderPage()
    expect(screen.getByText('A relevant passage.')).toBeInTheDocument()
    expect(screen.getByText('Report.txt')).toBeInTheDocument()
  })

  it('renders the no-results state when results are empty', () => {
    mockState = { data: [], isPending: false, error: null }
    renderPage()
    expect(screen.getByText(/no matches found/i)).toBeInTheDocument()
  })

  it('renders an error state when the search errors', () => {
    mockState = { data: undefined, isPending: false, error: new Error('boom') }
    renderPage()
    expect(screen.getByText(/something went wrong with your search/i)).toBeInTheDocument()
  })

  it('renders a passage containing HTML as TEXT, not markup', () => {
    const malicious = '<img src=x onerror=alert(1)><b>bold</b>'
    mockState = { data: [result({ content: malicious })], isPending: false, error: null }
    const { container } = renderPage()
    expect(screen.getByText(malicious)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('renders an https web_view_link as an anchor with rel=noopener noreferrer', () => {
    mockState = {
      data: [result({ web_view_link: 'https://drive.google.com/file/d/abc/view' })],
      isPending: false,
      error: null,
    }
    renderPage()
    const link = screen.getByRole('link', { name: 'Report.txt' })
    expect(link).toHaveAttribute('href', 'https://drive.google.com/file/d/abc/view')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders a javascript: web_view_link as plain text, NOT an anchor', () => {
    const jsUrl = ['javascript', 'alert(1)'].join(':')
    mockState = {
      data: [result({ web_view_link: jsUrl })],
      isPending: false,
      error: null,
    }
    renderPage()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Report.txt')).toBeInTheDocument()
  })

  it('renders a non-https (http) web_view_link as plain text, NOT an anchor', () => {
    mockState = {
      data: [result({ web_view_link: 'http://example.com/x' })],
      isPending: false,
      error: null,
    }
    renderPage()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Report.txt')).toBeInTheDocument()
  })

  it('renders a null web_view_link as plain text, NOT an anchor', () => {
    mockState = {
      data: [result({ web_view_link: null })],
      isPending: false,
      error: null,
    }
    renderPage()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Report.txt')).toBeInTheDocument()
  })

  it('submits the query when non-empty', () => {
    renderPage()
    submit()
    expect(mockMutate).toHaveBeenCalledWith({ query: 'what is the budget' })
  })

  it('does NOT submit when the query is empty/whitespace', () => {
    renderPage()
    const input = screen.getByLabelText(/search your collected email and files/i)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /search/i }))
    expect(mockMutate).not.toHaveBeenCalled()
  })
})
