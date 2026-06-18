import type { MessageListItem } from '@/services/messages.service'
import MessageItem from './MessageItem'
import styles from './MessageList.module.scss'

interface Props {
  messages: MessageListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  accountMap: Map<string, string>
}

export default function MessageList({ messages, selectedId, onSelect, accountMap }: Props) {
  return (
    <div className={styles.list}>
      {messages.map(msg => (
        <MessageItem
          key={msg.id}
          message={msg}
          accountEmail={accountMap.get(msg.connected_account_id)}
          isSelected={msg.id === selectedId}
          onClick={() => onSelect(msg.id)}
        />
      ))}
    </div>
  )
}
