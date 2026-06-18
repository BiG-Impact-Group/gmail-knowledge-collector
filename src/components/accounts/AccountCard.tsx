import styles from './AccountCard.module.scss'
import type { ConnectedAccount } from '@/services/accounts.service'
import { initiateOAuth } from '@/services/accounts.service'

interface Props {
  account: ConnectedAccount
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

export default function AccountCard({ account }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.info}>
          <span className={styles.email}>{account.email_address}</span>
          <span className={styles.provider}>Google</span>
        </div>
        <span className={`${styles.status} ${styles[account.status as keyof typeof styles]}`}>
          {account.status}
        </span>
      </div>
      <div className={styles.footer}>
        <span className={styles.synced}>
          Last synced: {formatRelativeTime(account.last_synced_at)}
        </span>
        {account.status === 'error' && (
          <button className={styles.reconnect} onClick={() => initiateOAuth('google')}>
            Reconnect
          </button>
        )}
      </div>
    </div>
  )
}
