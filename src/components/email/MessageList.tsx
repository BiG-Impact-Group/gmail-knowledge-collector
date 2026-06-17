import type { Message } from '@/services/messages.service'
import MessageItem from './MessageItem'
import styles from './MessageList.module.scss'

interface Props {
  messages: Message[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export default function MessageList({ messages, selectedId, onSelect }: Props) {
  return (
    <div className={styles.list}>
      {messages.map(msg => (
        <MessageItem
          key={msg.id}
          message={msg}
          isSelected={msg.id === selectedId}
          onClick={() => onSelect(msg.id)}
        />
      ))}
    </div>
  )
}
