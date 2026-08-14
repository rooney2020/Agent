import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { appendPreviewSelections, DirectiveContent, extractPreviewSelections } from './directive-text'

afterEach(cleanup)

describe('preview selection transcript card', () => {
  it('round-trips structured selections separately from editable text', () => {
    const selection = {
      annotations: [{ note: '保留背景去掉' }],
      format: 'pdf',
      label: 'GuideLine.pdf · 第 1 页',
      path: '/tmp/GuideLine.pdf',
      type: 'preview-annotation-collection'
    }
    const wireText = appendPreviewSelections('请修改这里', [selection])
    const parsed = extractPreviewSelections(wireText)

    expect(parsed.cleanedText).toBe('请修改这里')
    expect(parsed.selections).toEqual([selection])
    expect(wireText).toContain('<preview_selection>')
  })

  it('hides the wire payload by default and expands it on demand', () => {
    render(
      <DirectiveContent
        text={'把这里改成红色\n\n<preview_selection>\n{"type":"preview-region","format":"image","path":"/tmp/gem.png","coordinates":{"unit":"percent","x":69.7,"y":28.9,"width":7.7,"height":6.4}}\n</preview_selection>'}
      />
    )

    expect(screen.getByText('把这里改成红色')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: /gem\.png · 选区/ })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/"preview-region"/)).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/"preview-region"/)).toBeTruthy()
  })

  it('does not hide malformed selection payloads', () => {
    render(<DirectiveContent text={'<preview_selection>not-json</preview_selection>'} />)

    expect(screen.getByText(/not-json/)).toBeTruthy()
  })
})
