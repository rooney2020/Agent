import { atom } from 'nanostores'

export interface PreviewAnnotationDraft {
  label: string
  locator: Record<string, unknown>
  /** UI-only completion hook; never persisted into the annotation list. */
  onSaved?: () => void
  path: string
}

export interface PreviewAnnotation extends PreviewAnnotationDraft {
  comment: string
  id: string
}

export const $previewAnnotations = atom<PreviewAnnotation[]>([])
export const $pendingPreviewAnnotation = atom<PreviewAnnotationDraft | null>(null)

export function requestPreviewAnnotation(draft: PreviewAnnotationDraft) {
  $pendingPreviewAnnotation.set(draft)
}

export function addPreviewAnnotation(draft: PreviewAnnotationDraft, comment: string) {
  const { onSaved, ...annotation } = draft
  $previewAnnotations.set([
    ...$previewAnnotations.get(),
    { ...annotation, comment: comment.trim(), id: `annotation:${Date.now()}:${Math.random().toString(36).slice(2)}` }
  ])
  $pendingPreviewAnnotation.set(null)
  onSaved?.()
}

export function updatePreviewAnnotation(id: string, comment: string) {
  const nextComment = comment.trim()
  if (!nextComment) return
  $previewAnnotations.set(
    $previewAnnotations.get().map(item => (item.id === id ? { ...item, comment: nextComment } : item))
  )
}

export function removePreviewAnnotation(id: string) {
  $previewAnnotations.set($previewAnnotations.get().filter(item => item.id !== id))
}
