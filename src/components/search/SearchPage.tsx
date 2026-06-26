import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSearch } from '@/hooks/useSearch'
import type { SearchResult } from '@/services/search.service'
import styles from './SearchPage.module.scss'

// Only render web_view_link as a clickable anchor when it parses to an https URL. Anything else
// (null, relative, javascript:, data:, http:) is rendered as plain text — never an anchor. This
// blocks javascript:/data: URL injection from untrusted citation metadata.
function safeHttpsLink(link: string | null): string | null {
  if (!link) return null
  try {
    const url = new URL(link)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function formatSimilarity(similarity: number): string {
  if (!Number.isFinite(similarity)) return ''
  return `${(similarity * 100).toFixed(0)}%`
}

function ResultCard({ result }: { result: SearchResult }) {
  const href = safeHttpsLink(result.web_view_link)
  const score = formatSimilarity(result.similarity)
  return (
    <li className={styles.card}>
      <div className={styles.cardHeader}>
        {href ? (
          <a
            className={styles.source}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {result.document_name}
          </a>
        ) : (
          <span className={styles.source}>{result.document_name}</span>
        )}
        {score && <span className={styles.score}>{score} match</span>}
      </div>
      {/* SECURITY: passage is untrusted collected content. Render as PLAIN TEXT only — never
          dangerouslySetInnerHTML. React escapes the text node inside <p>. */}
      <p className={styles.passage}>{result.content}</p>
    </li>
  )
}

export default function SearchPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const { mutate, data: results, isPending, error, reset } = useSearch()

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = query.trim()
    if (trimmed.length === 0) return // empty/whitespace submit is a no-op
    mutate({ query: trimmed })
  }

  const hasResults = !!results && results.length > 0
  const noResults = !!results && results.length === 0 && !isPending
  const showEmptyState = !results && !isPending && !error

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Ask</h1>
      </header>

      <div className={styles.body}>
        <form className={styles.searchForm} onSubmit={handleSubmit}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Ask a question…"
            aria-label="Search your collected email and files"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (results || error) reset()
            }}
          />
          <button type="submit" className={styles.submit} disabled={isPending}>
            {isPending ? 'Searching…' : 'Search'}
          </button>
        </form>

        {showEmptyState && (
          <p className={styles.empty}>Ask a question about your collected email and files</p>
        )}
        {isPending && <p className={styles.loading}>Searching…</p>}
        {error && (
          <p className={styles.error}>
            Something went wrong with your search. Please try again.
          </p>
        )}
        {noResults && <p className={styles.empty}>No matches found</p>}
        {hasResults && (
          <ul className={styles.results}>
            {results.map((r) => (
              <ResultCard key={`${r.document_id}-${r.chunk_index}`} result={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
