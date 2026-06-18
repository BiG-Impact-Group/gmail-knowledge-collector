import type { Message } from '@/services/messages.service'
import styles from './MessageDetail.module.scss'

interface Props {
  message: Message | null | undefined
  isLoading: boolean
}

function wrapWithCsp(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
  return `<!DOCTYPE html><html><head>${csp}</head><body>${html}</body></html>`
}

function formatFullDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function MessageDetail({ message, isLoading }: Props) {
  if (isLoading) {
    return <div className={styles.empty}>Loading…</div>
  }

  if (!message) {
    return <div className={styles.empty}>Select a message to read it.</div>
  }

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <h2 className={styles.subject}>{message.subject || '(no subject)'}</h2>
        <div className={styles.meta}>
          <span><strong>From:</strong> {message.from_address}</span>
          <span><strong>To:</strong> {message.to_addresses}</span>
          <span><strong>Date:</strong> {formatFullDate(message.internal_date)}</span>
        </div>
      </div>
      <div className={styles.body}>
        {message.body_html ? (
          <iframe
            srcDoc={wrapWithCsp(message.body_html)}
            sandbox=""
            className={styles.iframe}
            title={message.subject ?? 'Email content'}
          />
        ) : message.body_text ? (
          <pre className={styles.text}>{message.body_text}</pre>
        ) : (
          <p className={styles.noContent}>No content available for this message.</p>
        )}
      </div>
    </div>
  )
}
