import styles from './EmptyState.module.scss'

interface Props {
  message: string
  action?: { label: string; onClick: () => void }
}

export default function EmptyState({ message, action }: Props) {
  return (
    <div className={styles.container}>
      <p className={styles.message}>{message}</p>
      {action && (
        <button className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
