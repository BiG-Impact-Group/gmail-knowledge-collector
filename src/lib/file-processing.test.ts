import {
  classifyConversion,
  extractDocxText,
  isLikelyScanned,
  truncateUtf8,
  zipWithinLimits,
} from './file-processing'

describe('classifyConversion', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/msword', 'unsupported'],
    ['application/vnd.ms-excel', 'unsupported'],
    ['application/vnd.ms-powerpoint', 'unsupported'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'unsupported'],
    ['application/rtf', 'unsupported'],
    ['image/png', 'unsupported'],
    ['text/plain', 'unsupported'],
  ])('maps %s to %s', (mime, expected) => {
    expect(classifyConversion(mime)).toBe(expected)
  })
})

describe('extractDocxText', () => {
  it('extracts run text and inserts paragraph newlines', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second line</w:t></w:r></w:p>' +
      '</w:body></w:document>'
    expect(extractDocxText(xml)).toBe('Hello world\nSecond line')
  })

  it('decodes XML entities in run text', () => {
    const xml = '<w:p><w:r><w:t>a &amp; b &lt; c</w:t></w:r></w:p>'
    expect(extractDocxText(xml)).toBe('a & b < c')
  })

  it('tolerates prefix-less <t> tags', () => {
    const xml = '<p><r><t>plain</t></r></p>'
    expect(extractDocxText(xml)).toBe('plain')
  })

  it('returns empty string for empty / contentless xml', () => {
    expect(extractDocxText('')).toBe('')
    expect(extractDocxText('<w:document><w:body></w:body></w:document>')).toBe('')
  })
})

describe('isLikelyScanned', () => {
  it('is true for empty/whitespace-only text', () => {
    expect(isLikelyScanned('')).toBe(true)
    expect(isLikelyScanned('   \n\t  ')).toBe(true)
  })
  it('is false when any real text is present', () => {
    expect(isLikelyScanned('  some text  ')).toBe(false)
  })
})

describe('truncateUtf8', () => {
  it('returns the string unchanged when it fits', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello')
  })

  it('truncates ASCII at the byte boundary', () => {
    expect(truncateUtf8('hello world', 5)).toBe('hello')
  })

  it('never splits a multibyte codepoint', () => {
    // 'é' is 2 bytes (0xC3 0xA9). Cutting at 1 byte must drop the whole char.
    const out = truncateUtf8('é', 1)
    expect(out).toBe('')
    // Two é's = 4 bytes; capping at 3 keeps only the first (2 bytes), drops the partial second.
    expect(truncateUtf8('éé', 3)).toBe('é')
  })

  it('keeps a full multibyte char that exactly fits', () => {
    expect(truncateUtf8('é', 2)).toBe('é')
  })

  it('handles a 4-byte codepoint (emoji) boundary', () => {
    // '😀' is 4 bytes. Any cap < 4 must yield empty rather than a partial codepoint.
    expect(truncateUtf8('😀', 3)).toBe('')
    expect(truncateUtf8('😀', 4)).toBe('😀')
  })

  it('returns empty for non-positive maxBytes', () => {
    expect(truncateUtf8('abc', 0)).toBe('')
  })
})

describe('zipWithinLimits', () => {
  const limits = { maxEntries: 3, maxUncompressedBytes: 100 }

  it('accepts an archive within both caps', () => {
    expect(zipWithinLimits([{ uncompressedBytes: 40 }, { uncompressedBytes: 40 }], limits)).toBe(true)
  })

  it('rejects over the entry-count cap', () => {
    const entries = [
      { uncompressedBytes: 1 },
      { uncompressedBytes: 1 },
      { uncompressedBytes: 1 },
      { uncompressedBytes: 1 },
    ]
    expect(zipWithinLimits(entries, limits)).toBe(false)
  })

  it('rejects over the total-uncompressed-size cap (zip-bomb guard)', () => {
    expect(zipWithinLimits([{ uncompressedBytes: 60 }, { uncompressedBytes: 60 }], limits)).toBe(false)
  })

  it('accepts an empty archive', () => {
    expect(zipWithinLimits([], limits)).toBe(true)
  })
})
