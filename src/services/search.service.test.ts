import { searchKnowledge, type SearchResult } from './search.service'

const mockInvoke = jest.fn()

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
  },
}))

const sampleResult: SearchResult = {
  document_id: 'doc-1',
  document_name: 'Report.txt',
  web_view_link: 'https://drive.google.com/file/d/abc/view',
  content: 'A relevant passage.',
  chunk_index: 0,
  similarity: 0.87,
}

describe('search.service', () => {
  beforeEach(() => jest.clearAllMocks())

  it('invokes the search edge function with the query and returns typed results', async () => {
    mockInvoke.mockResolvedValue({ data: { results: [sampleResult] }, error: null })
    const results = await searchKnowledge('hello')
    expect(mockInvoke).toHaveBeenCalledWith('search', { body: { query: 'hello' } })
    expect(results).toEqual([sampleResult])
  })

  it('passes limit in the body when provided', async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null })
    await searchKnowledge('hello', 3)
    expect(mockInvoke).toHaveBeenCalledWith('search', { body: { query: 'hello', limit: 3 } })
  })

  it('returns an empty array when the function returns no results', async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null })
    expect(await searchKnowledge('hello')).toEqual([])
  })

  it('returns an empty array when data is null', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: null })
    expect(await searchKnowledge('hello')).toEqual([])
  })

  it('propagates the error when the function returns one', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: new Error('invoke failed') })
    await expect(searchKnowledge('hello')).rejects.toThrow('invoke failed')
  })
})
