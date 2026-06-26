import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { useDocuments } from '@/hooks/useDocuments'
import { useDocument } from '@/hooks/useDocuments'
import { initiateGoogleDriveOAuth } from '@/services/documents.service'
import DocumentList from './DocumentList'
import DocumentDetail from './DocumentDetail'
import EmptyState from '@/components/shared/EmptyState'
import styles from './DocumentsPage.module.scss'

export default function DocumentsPage() {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [accountFilter, setAccountFilter] = useState<string | undefined>()
  const [connectError, setConnectError] = useState<string | null>(null)

  const { data: accounts, isLoading: accountsLoading } = useAccounts()
  const {
    data: documentsData,
    isLoading: documentsLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDocuments({ accountId: accountFilter })
  const { data: selectedDocument, isLoading: documentLoading } = useDocument(selectedId)

  const driveAccounts = useMemo(
    () => (accounts ?? []).filter(a => a.provider === 'google_drive'),
    [accounts],
  )

  const documents = documentsData?.pages.flatMap(p => p.documents) ?? []

  const accountMap = useMemo(() => {
    return new Map(driveAccounts.map(a => [a.id, a.email_address]))
  }, [driveAccounts])

  const handleFilterChange = (id: string | undefined) => {
    setAccountFilter(id)
    setSelectedId(null)
    setShowDetail(false)
  }

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setShowDetail(true)
  }

  const handleConnect = async () => {
    setConnectError(null)
    try {
      await initiateGoogleDriveOAuth()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }

  const noAccounts = !accountsLoading && driveAccounts.length === 0
  const hasDocuments = documents.length > 0
  const noDocuments = !documentsLoading && driveAccounts.length > 0 && documents.length === 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate('/accounts')}>
          ← Accounts
        </button>
        <h1 className={styles.title}>Documents</h1>
        {driveAccounts.length > 1 && (
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="account-filter">Account</label>
            <select
              id="account-filter"
              className={styles.filter}
              value={accountFilter ?? ''}
              onChange={e => handleFilterChange(e.target.value || undefined)}
            >
              <option value="">All accounts</option>
              {driveAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.email_address}</option>
              ))}
            </select>
          </div>
        )}
      </header>

      <div className={styles.layout}>
        <div className={`${styles.listPane} ${showDetail ? styles.hidden : ''}`}>
          {connectError && <p className={styles.errorMsg}>Connect error: {connectError}</p>}
          {noAccounts && (
            <EmptyState
              message="No Drive accounts connected."
              action={{ label: 'Connect Google Drive', onClick: handleConnect }}
            />
          )}
          {noDocuments && (
            <EmptyState message="Your files are being collected. Check back in a few minutes." />
          )}
          {!noAccounts && documentsLoading && (
            <p className={styles.loading}>Loading…</p>
          )}
          {hasDocuments && (
            <DocumentList
              documents={documents}
              selectedId={selectedId}
              onSelect={handleSelect}
              accountMap={accountMap}
            />
          )}
          {hasDocuments && hasNextPage && (
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
          <DocumentDetail
            document={selectedDocument}
            isLoading={!!selectedId && documentLoading}
          />
        </div>
      </div>
    </div>
  )
}
