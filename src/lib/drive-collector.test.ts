import {
  classifyFile,
  backoffMs,
  isRateLimitReason,
  driveFetchWith,
  readBounded,
  reduceChangesPage,
  nextChangesCursor,
  changesHasMore,
  chunk,
  MAX_CONTENT_BYTES,
  type MinimalResponse,
} from './drive-collector'

describe('classifyFile', () => {
  it('maps Google Workspace doc/sheet/slides to export with target mime', () => {
    expect(classifyFile('application/vnd.google-apps.document', null))
      .toEqual({ action: 'export_workspace', exportMimeType: 'text/plain' })
    expect(classifyFile('application/vnd.google-apps.spreadsheet', null))
      .toEqual({ action: 'export_workspace', exportMimeType: 'text/csv' })
    expect(classifyFile('application/vnd.google-apps.presentation', null))
      .toEqual({ action: 'export_workspace', exportMimeType: 'text/plain' })
  })

  it('downloads native text under the size cap', () => {
    expect(classifyFile('text/plain', 1000)).toEqual({ action: 'download_text' })
    expect(classifyFile('application/json', null)).toEqual({ action: 'download_text' })
  })

  it('marks oversized native text as needs_processing', () => {
    expect(classifyFile('text/plain', MAX_CONTENT_BYTES + 1)).toEqual({ action: 'needs_processing' })
  })

  it('marks docx/xlsx/pdf as needs_processing', () => {
    expect(classifyFile('application/pdf', 10).action).toBe('needs_processing')
    expect(classifyFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10).action).toBe('needs_processing')
    expect(classifyFile('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10).action).toBe('needs_processing')
  })

  it('skips images/video/forms/unknown', () => {
    expect(classifyFile('image/png', 10)).toEqual({ action: 'skip' })
    expect(classifyFile('video/mp4', 10)).toEqual({ action: 'skip' })
    expect(classifyFile('application/vnd.google-apps.form', null)).toEqual({ action: 'skip' })
  })
})

describe('backoffMs', () => {
  it('grows exponentially and caps at 8000', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(1)).toBe(2000)
    expect(backoffMs(2)).toBe(4000)
    expect(backoffMs(3)).toBe(8000)
    expect(backoffMs(10)).toBe(8000)
  })
})

describe('isRateLimitReason', () => {
  it('is true for rate-limit reasons only', () => {
    expect(isRateLimitReason('rateLimitExceeded')).toBe(true)
    expect(isRateLimitReason('userRateLimitExceeded')).toBe(true)
    expect(isRateLimitReason('insufficientPermissions')).toBe(false)
    expect(isRateLimitReason(undefined)).toBe(false)
  })
})

describe('driveFetchWith', () => {
  const noSleep = () => Promise.resolve()

  it('returns immediately on a 200', async () => {
    const doFetch = jest.fn<Promise<MinimalResponse>, []>().mockResolvedValue({ status: 200 })
    const res = await driveFetchWith(doFetch, () => false, noSleep)
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 up to maxRetries then gives up', async () => {
    const doFetch = jest.fn<Promise<MinimalResponse>, []>().mockResolvedValue({ status: 429 })
    const res = await driveFetchWith(doFetch, () => false, noSleep, 3)
    expect(res.status).toBe(429)
    expect(doFetch).toHaveBeenCalledTimes(4) // initial + 3 retries
  })

  it('retries a rate-limit 403 but not a permission 403', async () => {
    const rateLimited = jest.fn<Promise<MinimalResponse>, []>().mockResolvedValue({ status: 403 })
    await driveFetchWith(rateLimited, () => true, noSleep, 2)
    expect(rateLimited).toHaveBeenCalledTimes(3)

    const permission = jest.fn<Promise<MinimalResponse>, []>().mockResolvedValue({ status: 403 })
    const res = await driveFetchWith(permission, () => false, noSleep, 2)
    expect(res.status).toBe(403)
    expect(permission).toHaveBeenCalledTimes(1)
  })

  it('eventually returns a success after transient 429s', async () => {
    const doFetch = jest.fn<Promise<MinimalResponse>, []>()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 200 })
    const res = await driveFetchWith(doFetch, () => false, noSleep)
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })
})

describe('readBounded', () => {
  function streamResponse(parts: string[], contentLength?: number): Response {
    const encoder = new TextEncoder()
    const queue = parts.map(p => encoder.encode(p))
    let cancelled = false
    const reader = {
      read: async () => {
        const value = queue.shift()
        return value ? { done: false, value } : { done: true, value: undefined }
      },
      cancel: async () => { cancelled = true },
    }
    const headers = new Headers()
    if (contentLength !== undefined) headers.set('content-length', String(contentLength))
    return {
      headers,
      body: { getReader: () => reader, cancel: async () => { cancelled = true } },
      arrayBuffer: async () => encoder.encode(parts.join('')).buffer,
      get _cancelled() { return cancelled },
    } as unknown as Response
  }

  it('reads the full body when under the cap', async () => {
    const res = streamResponse(['hello ', 'world'])
    expect(await readBounded(res, 1000)).toBe('hello world')
  })

  it('trims an oversized final chunk to the cap', async () => {
    const res = streamResponse(['aaaa', 'bbbb'])
    const out = await readBounded(res, 6)
    expect(out).toBe('aaaabb')
    expect(out.length).toBe(6)
  })

  it('throws content_too_large and cancels when content-length far exceeds the cap', async () => {
    const res = streamResponse(['x'], 10_000_000)
    await expect(readBounded(res, MAX_CONTENT_BYTES)).rejects.toThrow('content_too_large')
  })
})

describe('reduceChangesPage', () => {
  it('partitions removals (removed flag or trashed file) from live files', () => {
    const page = {
      changes: [
        { fileId: 'a', removed: true },
        { fileId: 'b', file: { id: 'b', name: 'B', mimeType: 'text/plain', trashed: true } },
        { fileId: 'c', file: { id: 'c', name: 'C', mimeType: 'text/plain' } },
      ],
    }
    const { removedIds, liveFiles } = reduceChangesPage(page)
    expect(removedIds).toEqual(['a', 'b'])
    expect(liveFiles.map(f => f.id)).toEqual(['c'])
  })
})

describe('changes cursor advancement', () => {
  it('advances to nextPageToken while pages remain', () => {
    const page = { nextPageToken: 'next-1', changes: [] }
    expect(changesHasMore(page)).toBe(true)
    expect(nextChangesCursor(page)).toBe('next-1')
  })

  it('advances to newStartPageToken on the final page', () => {
    const page = { newStartPageToken: 'start-99', changes: [] }
    expect(changesHasMore(page)).toBe(false)
    expect(nextChangesCursor(page)).toBe('start-99')
  })

  it('applies a multi-page sequence: removals delete by fileId, cursor lands on newStartPageToken', () => {
    const pages = [
      { nextPageToken: 'p2', changes: [{ fileId: 'x', file: { id: 'x', name: 'X', mimeType: 'text/plain' } }] },
      { newStartPageToken: 'final', changes: [{ fileId: 'y', removed: true }] },
    ]
    const allRemoved: string[] = []
    const allLive: string[] = []
    let cursor: string | null = null
    for (const page of pages) {
      const reduced = reduceChangesPage(page)
      allRemoved.push(...reduced.removedIds)
      allLive.push(...reduced.liveFiles.map(f => f.id!))
      cursor = nextChangesCursor(page)
    }
    expect(allLive).toEqual(['x'])
    expect(allRemoved).toEqual(['y'])
    expect(cursor).toBe('final')
  })
})

describe('chunk', () => {
  it('splits into sub-batches of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('returns empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([])
  })
})
