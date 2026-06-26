import type { Document } from '@/services/documents.service'
import styles from './DocumentDetail.module.scss'

interface Props {
  document: Document | null | undefined
  isLoading: boolean
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

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_MESSAGES: Record<string, string> = {
  needs_processing: 'Content extraction pending (Epic 05).',
  needs_ocr: 'OCR required — this file contains scanned content.',
  skipped: 'Content not available for this file type.',
}

export default function DocumentDetail({ document, isLoading }: Props) {
  if (isLoading) {
    return <div className={styles.empty}>Loading…</div>
  }

  if (!document) {
    return <div className={styles.empty}>Select a file to view its content.</div>
  }

  const statusMessage = STATUS_MESSAGES[document.content_status]
  const size = formatSize(document.size_bytes)

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <h2 className={styles.name}>{document.name}</h2>
        <div className={styles.meta}>
          <span><strong>Type:</strong> {document.mime_type}</span>
          {size && <span><strong>Size:</strong> {size}</span>}
          <span><strong>Modified:</strong> {formatFullDate(document.drive_modified_time)}</span>
          {document.web_view_link && (
            <span>
              <a
                className={styles.driveLink}
                href={document.web_view_link}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Google Drive ↗
              </a>
            </span>
          )}
        </div>
      </div>
      <div className={styles.body}>
        {document.content_status === 'extracted' ? (
          document.text_content ? (
            // SECURITY: text_content is untrusted collected content. Render as PLAIN TEXT
            // ONLY — never dangerouslySetInnerHTML — even for text/html source files. React
            // escapes this automatically inside the <pre> text node.
            <pre className={styles.text}>{document.text_content}</pre>
          ) : (
            <p className={styles.noContent}>No content available for this file.</p>
          )
        ) : (
          <p className={styles.statusMessage}>{statusMessage}</p>
        )}
      </div>
    </div>
  )
}
