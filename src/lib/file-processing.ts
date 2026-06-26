// Pure, testable helpers for the file-processor edge function (Epic 05).
// These contain no Deno-specific globals or library imports so they can be unit-tested
// under Jest (mirrors the drive-collector.ts pure-helper pattern). The edge function
// duplicates this logic inline because edge functions cannot import from src/.

// Conversion classes the processor knows how to handle.
export type ConversionKind = 'pdf' | 'docx' | 'xlsx' | 'unsupported'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Map a Drive mime type to a conversion path. Legacy/binary office formats and anything
// else fall through to 'unsupported' (the processor marks those documents 'skipped').
export function classifyConversion(mimeType: string): ConversionKind {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === DOCX_MIME) return 'docx'
  if (mimeType === XLSX_MIME) return 'xlsx'
  return 'unsupported'
}

// Extract plain text from the raw `word/document.xml` of a .docx. Concatenates the text of
// every <w:t> run; inserts a newline at every paragraph boundary (</w:p>). Namespace prefixes
// other than `w:` are tolerated (some producers emit no prefix). No DOM — regex over the XML
// string is sufficient for run text and is allocation-bounded by the (already capped) input.
export function extractDocxText(documentXml: string): string {
  if (!documentXml) return ''

  // Split on paragraph close so each paragraph becomes its own line.
  const paragraphs = documentXml.split(/<\/w:p>/i)
  const lines: string[] = []
  // Matches <w:t>, <w:t xml:space="preserve">, and prefix-less <t>.
  const runRe = /<(?:w:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:)?t>/gi

  for (const para of paragraphs) {
    let text = ''
    let m: RegExpExecArray | null
    while ((m = runRe.exec(para)) !== null) {
      text += decodeXmlEntities(m[1])
    }
    if (text.length > 0) lines.push(text)
  }

  return lines.join('\n')
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// A PDF whose extracted text layer is empty/whitespace-only is treated as scanned/image-only
// and routed to needs_ocr (a future OCR worker handles those).
export function isLikelyScanned(pdfText: string): boolean {
  return pdfText.trim().length === 0
}

// Truncate a string so its UTF-8 byte length is at most maxBytes, never splitting a multibyte
// codepoint. Returns the original string when it already fits. Decoding with fatal:false would
// emit a replacement char on a split, so instead we back the cut off to a codepoint boundary.
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const encoder = new TextEncoder()
  const bytes = encoder.encode(s)
  if (bytes.length <= maxBytes) return s

  // Back off to the start of a UTF-8 codepoint. Continuation bytes are 0b10xxxxxx (0x80–0xBF).
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--
  }
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// One archive entry as seen by an unzip step: its uncompressed (original) size in bytes.
export interface ZipEntryInfo {
  uncompressedBytes: number
}

export interface ZipLimits {
  maxEntries: number
  maxUncompressedBytes: number
}

// Zip-bomb guard: returns true only if the archive is within BOTH the entry-count cap and the
// total-uncompressed-size cap. Pure so the processor can gate xlsx/docx unzips before
// materializing any decompressed bytes.
export function zipWithinLimits(entries: ZipEntryInfo[], limits: ZipLimits): boolean {
  if (entries.length > limits.maxEntries) return false
  let total = 0
  for (const e of entries) {
    total += e.uncompressedBytes
    if (total > limits.maxUncompressedBytes) return false
  }
  return true
}
