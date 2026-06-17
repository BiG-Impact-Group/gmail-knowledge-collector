import { useNavigate } from 'react-router-dom'
import { useAccounts } from '@/hooks/useAccounts'
import { initiateGoogleOAuth } from '@/services/accounts.service'
import AccountCard from './AccountCard'
import EmptyState from '@/components/shared/EmptyState'
import styles from './AccountsPage.module.scss'
import { supabase } from '@/lib/supabase'

export default function AccountsPage() {
  const navigate = useNavigate()
  const { data: accounts, isLoading, error } = useAccounts()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Connected Accounts</h1>
        <div className={styles.headerActions}>
          <button className={styles.connectBtn} onClick={initiateGoogleOAuth}>
            Connect Gmail
          </button>
          <button className={styles.signOutBtn} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {isLoading && <p className={styles.loading}>Loading…</p>}
        {error && <p className={styles.errorMsg}>Failed to load accounts.</p>}
        {accounts && accounts.length === 0 && (
          <EmptyState
            message="No accounts connected yet."
            action={{ label: 'Connect Gmail', onClick: initiateGoogleOAuth }}
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
          </div>
        )}
      </main>
    </div>
  )
}
