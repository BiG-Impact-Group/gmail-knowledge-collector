import { useState } from 'react'
import styles from './DisconnectModal.module.scss'

interface Props {
  emailAddress: string
  onConfirm: (purgeMessages: boolean) => void
  onCancel: () => void
  isLoading?: boolean
}

export default function DisconnectModal({ emailAddress, onConfirm, onCancel, isLoading }: Props) {
  const [purgeMessages, setPurgeMessages] = useState(false)

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="disconnect-heading">
      <div className={styles.modal}>
        <h2 id="disconnect-heading" className={styles.heading}>
          Disconnect {emailAddress}?
        </h2>
        <p className={styles.subtext}>
          This will revoke Google&apos;s access and stop syncing. Your account and any collected
          emails can be kept or removed.
        </p>

        <div className={styles.options}>
          <label className={styles.option}>
            <input
              type="radio"
              name="purge"
              value="keep"
              checked={!purgeMessages}
              onChange={() => setPurgeMessages(false)}
            />
            <span className={styles.optionText}>
              <strong>Keep my collected emails</strong>
              <span className={styles.optionHint}>I may want to reconnect later</span>
            </span>
          </label>

          <label className={styles.option}>
            <input
              type="radio"
              name="purge"
              value="purge"
              checked={purgeMessages}
              onChange={() => setPurgeMessages(true)}
            />
            <span className={styles.optionText}>
              <strong>Delete my collected emails</strong>
              <span className={styles.optionHint}>Remove all synced data for this account</span>
            </span>
          </label>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.confirmButton}
            onClick={() => onConfirm(purgeMessages)}
            disabled={isLoading}
          >
            {isLoading ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>
    </div>
  )
}
