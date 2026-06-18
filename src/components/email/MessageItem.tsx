import type { MessageListItem } from '@/services/messages.service'
import styles from './MessageItem.module.scss'

interface Props {
  message: MessageListItem
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

function extractSenderName(from: string | null): string {
  if (!from) return '(unknown)'
  const match = from.match(/^"?([^"<]+)"?\s*<?/)
  return match ? match[1].trim() : from
}

function decodeEntities(str: string | null): string {
  if (!str) return ''
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

export default function MessageItem({ message, accountEmail, isSelected, onClick }: Props) {
  return (
    <button
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles.sender}>{extractSenderName(message.from_address)}</div>
      <div className={styles.date}>{formatDate(message.internal_date)}</div>
      {accountEmail && (
        <div className={styles.account}>{accountEmail}</div>
      )}
      <div className={styles.subject}>{message.subject || '(no subject)'}</div>
      <div className={styles.snippet}>{decodeEntities(message.snippet)}</div>
    </button>
  )
}
