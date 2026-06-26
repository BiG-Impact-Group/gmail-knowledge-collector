import type { DocumentListItem } from '@/services/documents.service'
import styles from './DocumentItem.module.scss'

interface Props {
  document: DocumentListItem
  accountEmail?: string
  isSelected: boolean
  onClick: () => void
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fileTypeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'text/plain': 'Text',
    'text/csv': 'CSV',
    'text/markdown': 'Markdown',
    'text/html': 'HTML',
    'application/json': 'JSON',
  }
  return map[mimeType] ?? mimeType
}

const STATUS_BADGES: Record<string, string> = {
  needs_processing: 'Pending',
  needs_ocr: 'OCR',
  skipped: 'No content',
}

export default function DocumentItem({ document, accountEmail, isSelected, onClick }: Props) {
  const badge = STATUS_BADGES[document.content_status]
  return (
    <button
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles.name}>{document.name}</div>
      <div className={styles.date}>{formatDate(document.drive_modified_time)}</div>
      <div className={styles.type}>
        {fileTypeLabel(document.mime_type)}
        {badge && <span className={styles.badge}>{badge}</span>}
      </div>
      {accountEmail && (
        <div className={styles.account}>{accountEmail}</div>
      )}
    </button>
  )
}
