import { beforeEach, describe, expect, it } from 'vitest'

import { $previewTabs, type PreviewTab } from '@/store/preview'

import { defaultPreviewDock } from './preview-tile'

function tab(id: string): PreviewTab {
  return {
    id: `file:${id}`,
    target: {
      kind: 'file',
      label: id,
      source: `/tmp/${id}`,
      url: `file:///tmp/${id}`
    }
  }
}

describe('defaultPreviewDock', () => {
  beforeEach(() => {
    $previewTabs.set([])
  })

  it('opens the first preview beside the workspace', () => {
    const first = tab('first.pdf')
    $previewTabs.set([first])

    expect(defaultPreviewDock(first.id)).toEqual({ anchor: 'workspace', dir: 'right' })
  })

  it('stacks later previews as tabs in the existing preview workspace', () => {
    const first = tab('first.pdf')
    const second = tab('second.png')
    $previewTabs.set([first, second])

    expect(defaultPreviewDock(second.id)).toEqual({
      anchor: `preview-tile:${first.id}`,
      dir: 'center'
    })
  })
})
