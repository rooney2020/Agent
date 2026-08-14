import { useState } from 'react'

import { ToolIcon } from '@/components/ui/tool-icon'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { $previewTabs, closeRightRailTab, openPreview } from '@/store/preview'

function normalizedUrl(value: string) {
  const trimmed = value.trim()

  return !trimmed ? '' : /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function PreviewStart() {
  const [mode, setMode] = useState<'home' | 'web'>('home')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const closeChooser = () => {
    const chooser = $previewTabs.get().find(tab => tab.target.source === 'preview-start')

    if (chooser) closeRightRailTab(chooser.id)
  }

  const openFile = async () => {
    const paths = await window.hermesDesktop?.selectPaths({ multiple: true, title: '打开文件' })

    for (const path of paths || []) {
      const target = await normalizeOrLocalPreviewTarget(path)

      if (target) {
        closeChooser()
        openPreview(target, 'manual')
      }
    }
  }

  const navigate = () => {
    try {
      const next = normalizedUrl(url)

      if (!next) return
      const parsed = new URL(next)
      closeChooser()
      openPreview({ kind: 'url', label: parsed.hostname, source: next, url: next }, 'manual')
    } catch {
      setError('请输入有效的网址')
    }
  }

  if (mode === 'web') {
    return (
      <div className="preview-start-page">
        <div className="preview-start-browser-card">
          <div className="preview-start-address-row">
            <button aria-label="返回" onClick={() => setMode('home')} type="button">‹</button>
            <input
              aria-label="网页地址"
              autoFocus
              onChange={event => { setUrl(event.target.value); setError('') }}
              onKeyDown={event => { if (event.key === 'Enter') navigate() }}
              placeholder="输入网址，例如 example.com"
              value={url}
            />
            <button className="preview-start-go" onClick={navigate} type="button">打开</button>
          </div>
          {error && <p className="preview-start-error">{error}</p>}
          <div className="preview-start-browser-empty">
            <ToolIcon name="globe" size="2rem" />
            <h2>打开网页</h2>
            <p>输入地址后，网页将在当前预览标签中打开。</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="preview-start-page">
      <div className="preview-start-hero">
        <div className="preview-start-mark"><ToolIcon name="preview" size="1.35rem" /></div>
        <h1>从这里开始预览</h1>
        <p>打开本地文档、图片和代码，或者在应用内浏览网页。</p>
      </div>
      <div className="preview-start-actions">
        <button onClick={() => void openFile()} type="button">
          <span><ToolIcon name="folder" size="1.2rem" /></span><strong>打开文件</strong><small>PDF、Office、图片及代码文件</small>
        </button>
        <button onClick={() => setMode('web')} type="button">
          <span><ToolIcon name="globe" size="1.2rem" /></span><strong>打开网页</strong><small>输入网址并在当前标签浏览</small>
        </button>
      </div>
      <p className="preview-start-hint">也可以将文件直接拖放到此区域</p>
    </div>
  )
}
