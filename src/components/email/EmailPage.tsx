import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { useMessages } from '@/hooks/useMessages'
import { useMessage } from '@/hooks/useMessage'
import MessageList from './MessageList'
import MessageDetail from './MessageDetail'
import EmptyState from '@/components/shared/EmptyState'
import styles from './EmailPage.module.scss'

export default function EmailPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  const { data: accounts, isLoading: accountsLoading } = useAccounts()
  const { data: messages, isLoading: messagesLoading } = useMessages()
  const { data: selectedMessage, isLoading: messageLoading } = useMessage(selectedId)

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setShowDetail(true)
  }

  const noAccounts = !accountsLoading && accounts && accounts.length === 0
  const hasMessages = messages && messages.length > 0
  const noMessages = !messagesLoading && accounts && accounts.length > 0 && messages && messages.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Emails</h1>
      </header>

      <div className={styles.layout}>
        <div className={`${styles.listPane} ${showDetail ? styles.hidden : ''}`}>
          {noAccounts && (
            <EmptyState
              message="Connect a Gmail account to get started."
              action={{ label: 'Go to Accounts', onClick: () => navigate('/accounts') }}
            />
          )}
          {noMessages && (
            <EmptyState message="Your emails are being collected. Check back in a few minutes." />
          )}
          {!noAccounts && messagesLoading && (
            <p className={styles.loading}>Loading…</p>
          )}
          {hasMessages && (
            <MessageList
              messages={messages}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </div>

        <div className={`${styles.detailPane} ${showDetail ? styles.visible : ''}`}>
          {showDetail && (
            <button className={styles.backToList} onClick={() => setShowDetail(false)}>
              ← Back
            </button>
          )}
          <MessageDetail
            message={selectedMessage}
            isLoading={!!selectedId && messageLoading}
          />
        </div>
      </div>
    </div>
  )
}
