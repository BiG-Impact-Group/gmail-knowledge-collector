// Pure, testable text chunker for the embedder edge function.
// No Deno/Node globals so it can be unit-tested under Jest; the embedder copies this logic inline
// (edge functions cannot import from src/).
//
// Splits text into ~targetChars windows on paragraph/sentence/word boundaries, with overlapChars
// of trailing context carried into the next chunk so a fact split across a boundary stays
// retrievable. Caps the result at maxChunks (excess dropped — the caller flags `truncated`).

export interface ChunkOptions {
  targetChars: number
  overlapChars: number
  maxChunks: number
}

// Prefer to break at a paragraph break, then sentence end, then a space, searching backwards from
// the target window end. Returns an index in (start, hardEnd] at which to cut.
function findBreak(text: string, start: number, hardEnd: number): number {
  // Look only within the window we're about to emit.
  const window = text.slice(start, hardEnd)

  // 1. Paragraph boundary (double newline).
  const para = window.lastIndexOf('\n\n')
  if (para > 0) return start + para + 2

  // 2. Sentence boundary (. ! ? followed by whitespace).
  const sentenceRe = /[.!?]\s/g
  let sentenceCut = -1
  let m: RegExpExecArray | null
  while ((m = sentenceRe.exec(window)) !== null) {
    sentenceCut = m.index + m[0].length
  }
  if (sentenceCut > 0) return start + sentenceCut

  // 3. Whitespace boundary (avoid mid-word cuts).
  const space = window.lastIndexOf(' ')
  const newline = window.lastIndexOf('\n')
  const ws = Math.max(space, newline)
  if (ws > 0) return start + ws + 1

  // 4. No boundary found — hard cut at the window end.
  return hardEnd
}

export function chunkText(text: string, opts: ChunkOptions): string[] {
  const { targetChars, overlapChars, maxChunks } = opts
  if (maxChunks <= 0 || targetChars <= 0) return []

  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  // Whole thing fits in one chunk.
  if (trimmed.length <= targetChars) return [trimmed]

  // Clamp overlap so each step always makes forward progress (guards against infinite loops).
  const overlap = Math.max(0, Math.min(overlapChars, targetChars - 1))

  const chunks: string[] = []
  let start = 0
  const n = trimmed.length

  while (start < n && chunks.length < maxChunks) {
    const hardEnd = Math.min(start + targetChars, n)
    let end: number
    if (hardEnd >= n) {
      end = n
    } else {
      end = findBreak(trimmed, start, hardEnd)
      // Guarantee forward progress past the overlap rewind below.
      if (end <= start + overlap) end = hardEnd
    }

    const piece = trimmed.slice(start, end).trim()
    if (piece.length > 0) chunks.push(piece)

    if (end >= n) break
    // Step forward, carrying `overlap` chars of context. `end - overlap` is strictly > previous
    // start because end > start + overlap is guaranteed above.
    start = end - overlap
  }

  return chunks
}
