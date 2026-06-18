import { useMemo, useState } from 'react'
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
  const [accountFilter, setAccountFilter] = useState<string | undefined>()

  const { data: accounts, isLoading: accountsLoading } = useAccounts()
  const {
    data: messagesData,
    isLoading: messagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(accountFilter)
  const { data: selectedMessage, isLoading: messageLoading } = useMessage(selectedId)

  const messages = messagesData?.pages.flat() ?? []

  const accountMap = useMemo(() => {
    if (!accounts) return new Map<string, string>()
    return new Map(accounts.map(a => [a.id, a.email_address]))
  }, [accounts])

  const handleFilterChange = (id: string | undefined) => {
    setAccountFilter(id)
    setSelectedId(null)
    setShowDetail(false)
  }

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setShowDetail(true)
  }

  const noAccounts = !accountsLoading && accounts && accounts.length === 0
  const hasMessages = messages.length > 0
  const noMessages = !messagesLoading && accounts && accounts.length > 0 && messages.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Emails</h1>
        {accounts && accounts.length > 1 && (
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="account-filter">Account</label>
            <select
              id="account-filter"
              className={styles.filter}
              value={accountFilter ?? ''}
              onChange={e => handleFilterChange(e.target.value || undefined)}
            >
              <option value="">All accounts</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.email_address}</option>
              ))}
            </select>
          </div>
        )}
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
              accountMap={accountMap}
            />
          )}
          {hasMessages && hasNextPage && (
            <button
              className={styles.loadMore}
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
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
