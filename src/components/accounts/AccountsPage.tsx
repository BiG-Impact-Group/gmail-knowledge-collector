import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { initiateOAuth } from '@/services/accounts.service'
import { initiateGoogleDriveOAuth } from '@/services/documents.service'
import AccountCard from './AccountCard'
import EmptyState from '@/components/shared/EmptyState'
import styles from './AccountsPage.module.scss'
import { supabase } from '@/lib/supabase'

export default function AccountsPage() {
  const navigate = useNavigate()
  const { data: accounts, isLoading, error } = useAccounts()
  const [connectError, setConnectError] = React.useState<string | null>(null)

  const handleConnect = async () => {
    setConnectError(null)
    try {
      await initiateOAuth('google')
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleConnectDrive = async () => {
    setConnectError(null)
    try {
      await initiateGoogleDriveOAuth()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Connected Accounts</h1>
        <div className={styles.headerActions}>
          <button className={styles.connectBtn} onClick={handleConnect}>
            Connect Gmail
          </button>
          <button className={styles.connectBtn} onClick={handleConnectDrive}>
            Connect Google Drive
          </button>
          <button className={styles.signOutBtn} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {isLoading && <p className={styles.loading}>Loading…</p>}
        {error && <p className={styles.errorMsg}>Failed to load accounts.</p>}
        {connectError && <p className={styles.errorMsg}>Connect error: {connectError}</p>}
        {accounts && accounts.length === 0 && (
          <EmptyState
            message="No accounts connected yet."
            action={{ label: 'Connect Gmail', onClick: handleConnect }}
          />
        )}
        {accounts && accounts.length > 0 && (
          <div className={styles.list}>
            {accounts.map(account => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        )}
        {accounts && accounts.length > 0 && (
          <div className={styles.viewEmails}>
            <button className={styles.connectBtn} onClick={() => navigate('/emails')}>
              View Emails →
            </button>
            <button className={styles.connectBtn} onClick={() => navigate('/documents')}>
              View Documents →
            </button>
            <button className={styles.connectBtn} onClick={() => navigate('/ask')}>
              Ask →
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
