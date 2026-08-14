import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mainComposerScope } from '@/store/composer'
import { $previewAnnotations, requestPreviewAnnotation } from '@/store/preview-annotations'

import { PreviewAnnotationHub } from './preview-annotations'

describe('PreviewAnnotationHub', () => {
  beforeEach(() => {
    $previewAnnotations.set([])
    mainComposerScope.clear()
  })

  afterEach(cleanup)

  it('collects an annotation and attaches the complete collection', () => {
    const rendered = render(<PreviewAnnotationHub />)
    const onSaved = vi.fn()

    act(() => requestPreviewAnnotation({ label: 'spec.pdf · 第 2 页', locator: { page: 2, type: 'preview-pdf-element' }, onSaved, path: '/tmp/spec.pdf' }))
    fireEvent.change(rendered.getByPlaceholderText('描述需要关注或修改的内容…'), { target: { value: '这里需要补充说明' } })
    fireEvent.click(rendered.getByRole('button', { name: '保存批注' }))
    expect(onSaved).toHaveBeenCalledOnce()
    expect($previewAnnotations.get()[0]).not.toHaveProperty('onSaved')
    expect(rendered.getByText('这里需要补充说明')).toBeTruthy()

    fireEvent.click(rendered.getByRole('button', { name: '编辑' }))
    const editor = rendered.getByRole('textbox', { name: '编辑批注 1' })
    fireEvent.change(editor, { target: { value: '修改后的批注内容' } })
    fireEvent.click(rendered.getByRole('button', { name: '保存' }))
    expect(rendered.getByText('修改后的批注内容')).toBeTruthy()
    expect($previewAnnotations.get()[0]?.comment).toBe('修改后的批注内容')

    fireEvent.click(rendered.getByRole('button', { name: '引用全部批注并提交' }))

    expect(mainComposerScope.$attachments.get()[0]?.label).toBe('预览批注 · 1 条')
    expect(mainComposerScope.$attachments.get()[0]?.refText).toContain('修改后的批注内容')
    expect($previewAnnotations.get()).toEqual([])
  })
})
