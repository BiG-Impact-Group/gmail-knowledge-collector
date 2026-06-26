import styles from './DeleteAccountModal.module.scss'

interface Props {
  emailAddress: string
  onConfirm: () => void
  onCancel: () => void
  isLoading?: boolean
}

export default function DeleteAccountModal({ emailAddress, onConfirm, onCancel, isLoading }: Props) {
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="delete-heading">
      <div className={styles.modal}>
        <h2 id="delete-heading" className={styles.heading}>
          Delete {emailAddress}?
        </h2>
        <p className={styles.subtext}>
          This will permanently remove this connection and all collected emails. This cannot be
          undone.
        </p>

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
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  )
}
