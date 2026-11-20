import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createFolder,
  removeFolder,
  renameFolder,
  switchFolder,
  useChatStore,
} from '../../services/chat/store.js'
import { DEFAULT_FOLDER_ID } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './FolderSwitcher.module.css'

type Editor = 'create' | 'manage' | 'delete' | null

/** 文件夹元数据与配置由 Store 统一切换；收藏不在这里过滤。 */
export const FolderSwitcher = () => {
  const t = useTranslate()
  const folders = useChatStore((state) => state.folders)
  const activeFolderId = useChatStore((state) => state.activeFolderId)
  const busy = useChatStore((state) => state.switchingFolder || state.importingHistory)
  const [editor, setEditor] = useState<Editor>(null)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const active = folders.find((folder) => folder.id === activeFolderId)
  const disabled = busy || pending

  const open = (next: Exclude<Editor, null>) => {
    setName(next === 'create' ? '' : active?.name ?? '')
    setEditor(next)
  }
  const run = async (action: () => Promise<boolean>) => {
    setPending(true)
    try {
      if (await action()) {
        setEditor(null)
      } else {
        showToast({ key: 'folderOperationFailed', type: 'error' })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className={styles.row}>
        <Select
          value={activeFolderId}
          options={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
          ariaLabel={t('folderSwitcher')}
          className={styles.select}
          disabled={disabled}
          onChange={(folderId) => {
            void switchFolder(folderId).then((changed) => {
              if (!changed) { showToast({ key: 'folderOperationFailed', type: 'error' }) }
            })
          }}
        />
        <Button size="s" variant="outlined" disabled={disabled} onClick={() => open('create')}>
          {t('folderCreate')}
        </Button>
        <Button size="s" variant="outlined" disabled={disabled || !active} onClick={() => open('manage')}>
          {t('folderManage')}
        </Button>
      </div>
      {editor === 'create' || editor === 'manage' ? (
        <Modal
          title={t(editor === 'create' ? 'folderCreateTitle' : 'folderManageTitle')}
          onClose={() => { if (!pending) { setEditor(null) } }}
          footer={
            <>
              <Button variant="outlined" disabled={pending} onClick={() => setEditor(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={pending || !name.trim()}
                onClick={() => void run(editor === 'create'
                  ? () => createFolder(name.trim())
                  : () => renameFolder(activeFolderId, name.trim()))}
              >
                {t('confirm')}
              </Button>
            </>
          }
        >
          <label className={styles.field}>
            <span>{t('folderName')}</span>
            <input
              autoFocus
              value={name}
              maxLength={80}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {editor === 'manage' && activeFolderId !== DEFAULT_FOLDER_ID ? (
            <Button variant="dangerOutlined" disabled={pending} onClick={() => setEditor('delete')}>
              {t('folderDelete')}
            </Button>
          ) : null}
        </Modal>
      ) : null}
      {editor === 'delete' ? (
        <Modal
          title={t('folderDeleteTitle')}
          onClose={() => { if (!pending) { setEditor(null) } }}
          footer={
            <>
              <Button variant="outlined" disabled={pending} onClick={() => setEditor(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => void run(() => removeFolder(activeFolderId))}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('folderDeleteDescription', { name: active?.name ?? '' })}
        </Modal>
      ) : null}
    </>
  )
}
