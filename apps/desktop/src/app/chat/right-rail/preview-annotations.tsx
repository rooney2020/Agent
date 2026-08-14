import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { Codicon } from '@/components/ui/codicon'
import { mainComposerScope } from '@/store/composer'
import {
  $pendingPreviewAnnotation,
  $previewAnnotations,
  addPreviewAnnotation,
  removePreviewAnnotation,
  updatePreviewAnnotation
} from '@/store/preview-annotations'

export function PreviewAnnotationHub() {
  const annotations = useStore($previewAnnotations)
  const pending = useStore($pendingPreviewAnnotation)
  const [comment, setComment] = useState('')
  const [editingComment, setEditingComment] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const attachAll = () => {
    if (!annotations.length) return
    const locator = {
      type: 'preview-annotation-collection',
      annotations: annotations.map(({ comment: note, label, locator: selection, path }) => ({ label, note, path, selection }))
    }
    mainComposerScope.add({
      id: `preview-annotations:${Date.now()}`,
      kind: 'selection',
      label: `预览批注 · ${annotations.length} 条`,
      detail: annotations.map(item => item.label).join('、'),
      path: annotations[0]?.path,
      refText: `\n\n<preview_selection>\n${JSON.stringify(locator, null, 2)}\n</preview_selection>`
    })
    $previewAnnotations.set([])
    setOpen(false)
    requestComposerSubmit('请根据我在预览内容中添加的全部批注进行处理。', { target: 'main' })
  }

  return (
    <>
      {pending && (
        <div className="preview-annotation-backdrop" role="presentation">
          <form
            className="preview-annotation-dialog"
            onSubmit={event => {
              event.preventDefault()
              if (!comment.trim()) return
              addPreviewAnnotation(pending, comment)
              setComment('')
              setOpen(true)
            }}
          >
            <div><h2>添加批注</h2><p>{pending.label}</p></div>
            <textarea autoFocus onChange={event => setComment(event.target.value)} placeholder="描述需要关注或修改的内容…" rows={4} value={comment} />
            <div className="preview-annotation-dialog-actions">
              <button onClick={() => { $pendingPreviewAnnotation.set(null); setComment('') }} type="button">取消</button>
              <button disabled={!comment.trim()} type="submit">保存批注</button>
            </div>
          </form>
        </div>
      )}
      <button className="preview-annotation-list-trigger" onClick={() => setOpen(value => !value)} type="button">
        <Codicon name="comment-discussion" size="0.8125rem" />
        <strong>批注</strong>
        <span>{annotations.length}</span>
      </button>
      {open && (
        <aside className="preview-annotation-panel">
          <header>
            <div className="preview-annotation-panel-heading">
              <span className="preview-annotation-panel-mark"><Codicon name="comment-discussion" size="0.875rem" /></span>
              <div><strong>批注列表</strong><small>检查并整理后统一提交</small></div>
            </div>
            <div className="preview-annotation-panel-meta">
              <span>{annotations.length} 条</span>
              <button aria-label="关闭批注列表" onClick={() => setOpen(false)} type="button"><Codicon name="close" size="0.75rem" /></button>
            </div>
          </header>
          <div className="preview-annotation-items">
            {!annotations.length && <p className="preview-annotation-empty">选择内容后点击“添加批注”。</p>}
            {annotations.map((item, index) => (
              <article key={item.id}>
                <div>
                  <span className="preview-annotation-index">{String(index + 1).padStart(2, '0')}</span>
                  <strong>{item.label}</strong>
                  <div className="preview-annotation-item-actions">
                    <button
                      onClick={() => {
                        setEditingId(item.id)
                        setEditingComment(item.comment)
                      }}
                      type="button"
                    ><Codicon name="edit" size="0.6875rem" />编辑</button>
                    <button onClick={() => {
                      if (editingId === item.id) setEditingId(null)
                      removePreviewAnnotation(item.id)
                    }} type="button"><Codicon name="trash" size="0.6875rem" />删除</button>
                  </div>
                </div>
                {editingId === item.id ? (
                  <form
                    className="preview-annotation-inline-editor"
                    onSubmit={event => {
                      event.preventDefault()
                      if (!editingComment.trim()) return
                      updatePreviewAnnotation(item.id, editingComment)
                      setEditingId(null)
                    }}
                  >
                    <textarea
                      aria-label={`编辑批注 ${index + 1}`}
                      autoFocus
                      onChange={event => setEditingComment(event.target.value)}
                      rows={3}
                      value={editingComment}
                    />
                    <div>
                      <button onClick={() => setEditingId(null)} type="button">取消</button>
                      <button disabled={!editingComment.trim()} type="submit">保存</button>
                    </div>
                  </form>
                ) : <p className="preview-annotation-comment">{item.comment}</p>}
              </article>
            ))}
          </div>
          <footer>
            <small>{annotations.length ? `将引用 ${annotations.length} 条批注及其定位信息` : '添加批注后可统一提交'}</small>
            <button disabled={!annotations.length} onClick={attachAll} type="button">
              <Codicon name="send" size="0.75rem" />引用全部批注并提交
            </button>
          </footer>
        </aside>
      )}
    </>
  )
}
