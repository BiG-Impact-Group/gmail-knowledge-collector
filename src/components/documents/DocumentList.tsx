import type { DocumentListItem } from '@/services/documents.service'
import DocumentItem from './DocumentItem'
import styles from './DocumentList.module.scss'

interface Props {
  documents: DocumentListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  accountMap: Map<string, string>
}

export default function DocumentList({ documents, selectedId, onSelect, accountMap }: Props) {
  return (
    <div className={styles.list}>
      {documents.map(doc => (
        <DocumentItem
          key={doc.id}
          document={doc}
          accountEmail={accountMap.get(doc.connected_account_id)}
          isSelected={doc.id === selectedId}
          onClick={() => onSelect(doc.id)}
        />
      ))}
    </div>
  )
}
