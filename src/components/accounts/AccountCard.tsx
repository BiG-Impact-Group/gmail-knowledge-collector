import { useState } from 'react'
import styles from './AccountCard.module.scss'
import type { ConnectedAccount } from '@/services/accounts.service'
import { reconnectAccount } from '@/services/accounts.service'
import { useDisconnectAccount, useDeleteAccount } from '@/hooks/useAccounts'
import DisconnectModal from './DisconnectModal'
import DeleteAccountModal from './DeleteAccountModal'

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
  const [showDisconnect, setShowDisconnect] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)

  const disconnectMutation = useDisconnectAccount()
  const deleteMutation = useDeleteAccount()

  const canReconnect = account.status === 'error' || account.status === 'revoked'
  const canDisconnect = account.status === 'active' || account.status === 'error'

  async function handleReconnect() {
    setIsReconnecting(true)
    setReconnectError(null)
    try {
      await reconnectAccount(account.id)
    } catch (e) {
      setReconnectError((e as Error).message ?? 'Reconnect failed. Please try again.')
    } finally {
      setIsReconnecting(false)
    }
  }

  function handleDisconnectConfirm(purgeMessages: boolean) {
    disconnectMutation.mutate(
      { accountId: account.id, purgeMessages },
      { onSuccess: () => setShowDisconnect(false) },
    )
  }

  function handleDeleteConfirm() {
    deleteMutation.mutate(
      { accountId: account.id },
      { onSuccess: () => setShowDelete(false) },
    )
  }

  return (
    <>
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
          {reconnectError && (
            <span className={styles.reconnectError} role="alert">{reconnectError}</span>
          )}
          <div className={styles.actions}>
            {canReconnect && (
              <button
                className={styles.reconnect}
                onClick={handleReconnect}
                disabled={isReconnecting}
              >
                {isReconnecting ? 'Reconnecting…' : 'Reconnect'}
              </button>
            )}
            {canDisconnect && (
              <button className={styles.disconnect} onClick={() => setShowDisconnect(true)}>
                Disconnect
              </button>
            )}
            <button className={styles.delete} onClick={() => setShowDelete(true)}>
              Delete
            </button>
          </div>
        </div>
      </div>

      {showDisconnect && (
        <DisconnectModal
          emailAddress={account.email_address}
          onConfirm={handleDisconnectConfirm}
          onCancel={() => setShowDisconnect(false)}
          isLoading={disconnectMutation.isPending}
        />
      )}

      {showDelete && (
        <DeleteAccountModal
          emailAddress={account.email_address}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDelete(false)}
          isLoading={deleteMutation.isPending}
        />
      )}
    </>
  )
}
