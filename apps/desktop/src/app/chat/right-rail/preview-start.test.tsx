import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $previewTabs, openPreviewStart } from '@/store/preview'

import { PreviewStart } from './preview-start'

describe('PreviewStart', () => {
  beforeEach(() => {
    $previewTabs.set([])
    openPreviewStart()
  })

  afterEach(cleanup)

  it('opens a web address in the Browser tab and replaces the chooser', () => {
    const rendered = render(<PreviewStart />)

    fireEvent.click(rendered.getByText('打开网页'))
    fireEvent.change(rendered.getByLabelText('网页地址', { selector: 'input' }), { target: { value: 'example.com' } })
    fireEvent.click(rendered.getByRole('button', { name: '打开' }))

    expect($previewTabs.get().some(tab => tab.target.source === 'preview-start')).toBe(false)
    expect($previewTabs.get().find(tab => tab.target.kind === 'url')?.target.url).toBe('https://example.com')
  })
})
