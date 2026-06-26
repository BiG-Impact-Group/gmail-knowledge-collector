// Pure, testable helpers for the google-drive-collector edge function.
// These contain no Deno-specific globals so they can be unit-tested under Jest
// (mirrors the gmail-backfill.ts pure-helper pattern). The edge function imports
// the same logic (copied inline there because edge functions cannot import from src/).

export const DRIVE_PAGE_SIZE = 25
export const MAX_PAGES_PER_RUN = 4
export const RPC_DOC_BATCH = 5
export const MAX_CONTENT_BYTES = 500_000
export const UNCHANGED = '__unchanged__'

// Google Workspace native types are exported to a text format.
export const WORKSPACE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

export const NATIVE_TEXT_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'text/csv',
  'text/javascript', 'application/json', 'application/xml', 'text/xml',
])

export const BINARY_PROCESSING_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',        // xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',// pptx
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
])

export type ClassifyAction =
  | 'export_workspace'
  | 'download_text'
  | 'needs_processing'
  | 'needs_ocr'
  | 'skip'

export interface ClassifyResult {
  action: ClassifyAction
  exportMimeType?: string
}

export function classifyFile(mimeType: string, sizeBytes: number | null): ClassifyResult {
  if (WORKSPACE_EXPORTS[mimeType]) {
    return { action: 'export_workspace', exportMimeType: WORKSPACE_EXPORTS[mimeType] }
  }
  if (NATIVE_TEXT_TYPES.has(mimeType)) {
    if (sizeBytes !== null && sizeBytes > MAX_CONTENT_BYTES) return { action: 'needs_processing' }
    return { action: 'download_text' }
  }
  if (BINARY_PROCESSING_TYPES.has(mimeType)) {
    // TODO (Epic 05): distinguish scanned PDFs (needs_ocr) from text-layer PDFs.
    return { action: 'needs_processing' }
  }
  return { action: 'skip' } // images, video, audio, forms, etc.
}

// Truncated exponential backoff for a single attempt index. 1s, 2s, 4s (cap 8s).
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000)
}

// Determines whether a Drive 403 indicates a rate-limit (retryable) vs. a permanent
// permission error (not retryable). Inspect error.errors[0].reason.
export function isRateLimitReason(reason: string | undefined): boolean {
  return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
}

export interface MinimalResponse {
  status: number
}

// Bounded retry wrapper around a fetch-like function. Retries on 429 and on
// rate-limit-reason 403; gives up after maxRetries; never retries a non-rate-limit 403.
export async function driveFetchWith<R extends MinimalResponse>(
  doFetch: () => Promise<R>,
  is403RateLimited: (res: R) => Promise<boolean> | boolean,
  sleep: (ms: number) => Promise<void>,
  maxRetries = 3,
): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch()
    if (res.status !== 429 && res.status !== 403) return res
    if (res.status === 403 && !(await is403RateLimited(res))) return res
    if (attempt >= maxRetries) return res
    await sleep(backoffMs(attempt))
  }
}

// Bounded reader: returns at most maxBytes of text. Pre-checks Content-Length and throws
// 'content_too_large' when the declared size is far over the cap, so a huge export is never
// buffered. Cancels the stream once enough bytes are accumulated.
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export async function readBounded(res: Response, maxBytes = MAX_CONTENT_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes * 10) {
    await res.body?.cancel()
    throw new Error('content_too_large')
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return new TextDecoder().decode(buf.subarray(0, maxBytes))
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - total
    const slice = value.length > remaining ? value.subarray(0, remaining) : value
    chunks.push(slice)
    total += slice.length
  }
  await reader.cancel()
  return new TextDecoder().decode(concat(chunks))
}

// ---- Changes-API page reducer ----

export interface DriveFile {
  id?: string
  name?: string
  mimeType?: string
  webViewLink?: string
  size?: string
  modifiedTime?: string
  trashed?: boolean
}

export interface DriveChange {
  fileId?: string
  removed?: boolean
  file?: DriveFile
}

export interface ChangesPage {
  changes?: DriveChange[]
  nextPageToken?: string
  newStartPageToken?: string
}

export interface ReducedChangesPage {
  removedIds: string[]
  liveFiles: DriveFile[]
}

// Partition a Changes page into removals and live files.
// A change is a removal if removed === true OR file.trashed === true.
export function reduceChangesPage(page: ChangesPage): ReducedChangesPage {
  const removedIds: string[] = []
  const liveFiles: DriveFile[] = []
  for (const change of page.changes ?? []) {
    const isRemoved = change.removed === true || change.file?.trashed === true
    if (isRemoved) {
      if (change.fileId) removedIds.push(change.fileId)
      continue
    }
    if (change.file?.id) liveFiles.push(change.file)
  }
  return { removedIds, liveFiles }
}

// The new sync_cursor after applying a Changes page: nextPageToken while more pages
// remain, otherwise the terminal newStartPageToken.
export function nextChangesCursor(page: ChangesPage): string | null {
  return page.nextPageToken ?? page.newStartPageToken ?? null
}

export function changesHasMore(page: ChangesPage): boolean {
  return !!page.nextPageToken
}

// Chunk an array into sub-batches of at most `size` items (RPC payload chunking).
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
