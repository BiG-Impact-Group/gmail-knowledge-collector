import { chunkText } from '@/lib/chunking'

const OPTS = { targetChars: 1500, overlapChars: 200, maxChunks: 50 }

describe('chunkText', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(chunkText('', OPTS)).toEqual([])
    expect(chunkText('   \n\t  \n  ', OPTS)).toEqual([])
  })

  it('returns a single trimmed chunk when text fits the target', () => {
    const text = '  Hello world. This is a short document.  '
    expect(chunkText(text, OPTS)).toEqual(['Hello world. This is a short document.'])
  })

  it('splits long text into multiple chunks near the target size', () => {
    // ~6000 chars of sentence-y text → several chunks.
    const sentence = 'The quick brown fox jumps over the lazy dog. '
    const text = sentence.repeat(140) // ~6300 chars
    const chunks = chunkText(text, OPTS)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk should wildly exceed the target (allow slack for boundary search + overlap).
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(OPTS.targetChars + OPTS.overlapChars + 50)
    }
    // Most chunks should be reasonably full (not tiny slivers).
    expect(chunks[0].length).toBeGreaterThan(OPTS.targetChars / 2)
  })

  it('carries overlap context between consecutive chunks', () => {
    const sentence = 'Alpha beta gamma delta epsilon zeta eta theta. '
    const text = sentence.repeat(120)
    const chunks = chunkText(text, { targetChars: 800, overlapChars: 150, maxChunks: 50 })
    expect(chunks.length).toBeGreaterThan(1)
    // The tail of chunk i should reappear at the head of chunk i+1 (overlap present).
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].slice(-60).trim()
      // At least some token from the tail should open the next chunk.
      const firstWordOfTail = tail.split(/\s+/)[0]
      expect(chunks[i + 1]).toContain(firstWordOfTail)
    }
  })

  it('respects the maxChunks cap', () => {
    const text = 'word '.repeat(20000) // ~100k chars
    const chunks = chunkText(text, { targetChars: 500, overlapChars: 50, maxChunks: 10 })
    expect(chunks.length).toBe(10)
  })

  it('breaks on paragraph boundaries when present', () => {
    const para = 'A'.repeat(700)
    const text = `${para}\n\n${para}\n\n${para}`
    const chunks = chunkText(text, { targetChars: 1000, overlapChars: 100, maxChunks: 50 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('does not loop forever on huge unbroken input (no whitespace)', () => {
    const text = 'x'.repeat(200_000) // single token, no break points
    const start = Date.now()
    const chunks = chunkText(text, { targetChars: 1500, overlapChars: 200, maxChunks: 50 })
    expect(Date.now() - start).toBeLessThan(2000)
    // Hard-cut every targetChars-overlap step, capped at maxChunks.
    expect(chunks.length).toBe(50)
    expect(chunks.every(c => c.length > 0)).toBe(true)
  })

  it('does not loop forever when overlap >= target (clamped)', () => {
    const text = 'word '.repeat(2000)
    const chunks = chunkText(text, { targetChars: 100, overlapChars: 500, maxChunks: 20 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThanOrEqual(20)
  })

  it('returns [] for non-positive caps', () => {
    expect(chunkText('hello world', { targetChars: 0, overlapChars: 0, maxChunks: 10 })).toEqual([])
    expect(chunkText('hello world', { targetChars: 100, overlapChars: 0, maxChunks: 0 })).toEqual([])
  })
})
