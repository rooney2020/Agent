import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'
import { mainComposerScope } from '@/store/composer'

import { PreviewPane } from './preview-pane'
import { forgetPreviewStripTools, previewConsoleState } from './preview-strip-tools'

function stubPdfObjectUrls() {
  const NativeUrl = URL
  let objectUrlIndex = 0
  const createObjectURL = vi.fn((_blob: Blob) => `blob:pdf-preview-${(objectUrlIndex += 1)}`)
  const revokeObjectURL = vi.fn()

  class TestUrl extends NativeUrl {}

  Object.defineProperties(TestUrl, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL }
  })
  vi.stubGlobal('URL', TestUrl)

  return { createObjectURL, revokeObjectURL }
}

describe('PreviewPane console state', () => {
  beforeEach(() => {
    mainComposerScope.clear()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    vi.unstubAllGlobals()
  })

  it('does not watch backend-only remote filesystem previews locally', async () => {
    const watchPreviewFile = vi.fn(async () => ({ id: 'watch-1', path: '/remote/file.txt' }))
    const onPreviewFileChanged = vi.fn(() => vi.fn())
    $connection.set({ mode: 'remote' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        onPreviewFileChanged,
        watchPreviewFile
      }
    })

    await act(async () => {
      render(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'file.txt',
            path: '/remote/file.txt',
            previewKind: 'text',
            source: '/remote/file.txt',
            url: 'file:///remote/file.txt'
          }}
        />
      )
    })

    expect(watchPreviewFile).not.toHaveBeenCalled()
    expect(onPreviewFileChanged).not.toHaveBeenCalled()
  })

  // The console lives in the TAB's store (the toggles sit on the tab, not in the
  // titlebar), so a streamed log has to land in the store keyed by tabId — that
  // is what both the panel in the pane and the button on the tab read.
  it('streams console logs into the tab-keyed console store', async () => {
    const tabId = 'url:http://localhost:5174'

    forgetPreviewStripTools(tabId)

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          tabId={tabId}
          target={{
            kind: 'url',
            label: 'Preview',
            source: 'http://localhost:5174',
            url: 'http://localhost:5174'
          }}
        />
      )
    })

    const webview = rendered.container.querySelector('webview')

    expect(webview).toBeInstanceOf(HTMLElement)

    act(() => {
      webview?.dispatchEvent(
        Object.assign(new Event('console-message'), {
          level: 0,
          message: 'streamed log line',
          sourceId: 'http://localhost:5174/src/main.tsx'
        })
      )
    })

    expect(previewConsoleState(tabId).$logs.get().at(-1)?.message).toBe('streamed log line')

    forgetPreviewStripTools(tabId)
  })

  it('tracks guest navigation history without rewriting page overflow', async () => {
    const rendered = render(
      <PreviewPane
        target={{ kind: 'url', label: 'Example', source: 'https://example.com', url: 'https://example.com' }}
      />
    )
    const webview = rendered.container.querySelector('webview') as HTMLElement & {
      canGoBack?: ReturnType<typeof vi.fn>
      canGoForward?: ReturnType<typeof vi.fn>
      goBack?: ReturnType<typeof vi.fn>
      goForward?: ReturnType<typeof vi.fn>
      loadURL?: ReturnType<typeof vi.fn>
      reloadIgnoringCache?: ReturnType<typeof vi.fn>
    }
    webview.canGoBack = vi.fn(() => true)
    webview.canGoForward = vi.fn(() => true)
    webview.goBack = vi.fn()
    webview.goForward = vi.fn()
    webview.loadURL = vi.fn().mockResolvedValue(undefined)
    webview.reloadIgnoringCache = vi.fn()

    expect(rendered.getByRole('button', { name: '后退' }).hasAttribute('disabled')).toBe(true)
    expect(rendered.getByRole('button', { name: '前进' }).hasAttribute('disabled')).toBe(true)

    act(() => {
      webview.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.org/current' }))
    })
    fireEvent.click(rendered.getByRole('button', { name: '后退' }))
    fireEvent.click(rendered.getByRole('button', { name: '前进' }))
    expect(webview.goBack).toHaveBeenCalledOnce()
    expect(webview.goForward).toHaveBeenCalledOnce()
    expect(webview.getAttribute('style') ?? '').not.toContain('overflow')

    fireEvent.click(rendered.getByRole('button', { name: '刷新' }))
    fireEvent.keyDown(window, { key: 'F5' })
    expect(webview.reloadIgnoringCache).toHaveBeenCalledTimes(2)

    act(() => {
      webview.dispatchEvent(Object.assign(new Event('new-window', { cancelable: true }), { url: 'https://example.org/next' }))
    })
    expect(webview.loadURL).toHaveBeenCalledWith('https://example.org/next')
    expect((rendered.getByRole('textbox', { name: '网页地址' }) as HTMLInputElement).value).toBe(
      'https://example.org/next'
    )
  })

  it('renders authenticated remote HTML safely and honors source mode', async () => {
    const dataUrl = `data:text/html;base64,${btoa('<h1>remote</h1>')}`

    const target = {
      dataUrl,
      kind: 'file' as const,
      label: 'report.html',
      path: '/srv/report.html',
      previewKind: 'html' as const,
      source: '/srv/report.html',
      url: 'file:///srv/report.html'
    }

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(<PreviewPane target={target} />)
    })

    const iframe = rendered.container.querySelector('iframe')

    expect(rendered.container.querySelector('webview')).toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('srcdoc')).toContain(`default-src 'none'`)
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>remote</h1>')
    expect(rendered.container.textContent).not.toContain(dataUrl)

    await act(async () => {
      rendered.rerender(
        <PreviewPane target={{ ...target, dataUrl: undefined, renderMode: 'source', transient: true }} />
      )
    })

    expect(rendered.container.querySelector('iframe')).toBeNull()
    const sourceLink = rendered.container.querySelector('a')

    expect(sourceLink?.getAttribute('href')).toBeNull()
    expect(sourceLink?.getAttribute('target')).toBeNull()
    expect(fireEvent.click(sourceLink!)).toBe(false)
  })

  it('renders PDF targets in the application viewer', async () => {
    const dataUrl = 'data:application/pdf;base64,JVBERi0xLjQ='
    const readFileDataUrl = vi.fn(async () => dataUrl)
    const { createObjectURL, revokeObjectURL } = stubPdfObjectUrls()
    $connection.set({ mode: 'local' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        readFileDataUrl
      }
    })

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'spec.pdf',
            path: '/tmp/spec.pdf',
            previewKind: 'pdf',
            source: '/tmp/spec.pdf',
            url: 'file:///tmp/spec.pdf'
          }}
        />
      )
    })

    await waitFor(() => expect(rendered.container.querySelector('[data-slot="pdf-document-viewer"]')).not.toBeNull(), {
      container: rendered.container
    })
    expect(rendered.container.querySelector('iframe')).toBeNull()
    expect(readFileDataUrl).toHaveBeenCalledWith('/tmp/spec.pdf')
    const blob = createObjectURL.mock.calls[0]?.[0]

    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.type).toBe('application/pdf')
    expect(await blob?.text()).toBe('%PDF-1.4')

    await act(async () => {
      rendered.rerender(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'other.pdf',
            path: '/tmp/other.pdf',
            previewKind: 'pdf',
            source: '/tmp/other.pdf',
            url: 'file:///tmp/other.pdf'
          }}
        />
      )
    })

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2), {
      container: rendered.container
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-preview-1')
    expect(rendered.container.querySelector('[data-slot="pdf-document-viewer"]')).not.toBeNull()

    rendered.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-preview-2')
  })

  it('adds a structured PDF region reference to the composer', async () => {
    const readFileDataUrl = vi.fn(async () => 'data:application/pdf;base64,JVBERi0xLjQ=')
    stubPdfObjectUrls()
    $connection.set({ mode: 'local' } as never)
    vi.stubGlobal('window', {
      ...window,
      dispatchEvent: window.dispatchEvent.bind(window),
      hermesDesktop: { readFileDataUrl }
    })

    const rendered = render(
      <PreviewPane
        target={{
          kind: 'file',
          label: 'spec.pdf',
          path: '/tmp/spec.pdf',
          previewKind: 'pdf',
          source: '/tmp/spec.pdf',
          url: 'file:///tmp/spec.pdf'
        }}
      />
    )

    await waitFor(() => expect(rendered.container.querySelector('button[aria-pressed="false"]')).not.toBeNull(), {
      container: rendered.container
    })
    fireEvent.click(rendered.container.querySelector('button[aria-pressed="false"]')!)

    const overlay = rendered.container.querySelector('.cursor-crosshair') as HTMLDivElement
    Object.defineProperties(overlay, {
      getBoundingClientRect: {
        value: () => ({ bottom: 200, height: 200, left: 0, right: 400, top: 0, width: 400, x: 0, y: 0 })
      },
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: vi.fn() }
    })
    fireEvent.pointerDown(overlay, { clientX: 40, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(overlay, { clientX: 240, clientY: 140, pointerId: 1 })
    fireEvent.pointerUp(overlay, { clientX: 240, clientY: 140, pointerId: 1 })
    const attachButton = Array.from(rendered.container.querySelectorAll('button')).find(
      button => button.textContent === '引用此区域'
    )

    expect(attachButton).toBeTruthy()
    fireEvent.pointerDown(attachButton!, { clientX: 200, clientY: 190, pointerId: 2 })
    fireEvent.pointerUp(attachButton!, { clientX: 200, clientY: 190, pointerId: 2 })
    fireEvent.click(attachButton!)

    expect(mainComposerScope.$attachments.get()).toMatchObject([
      {
        kind: 'selection',
        label: 'spec.pdf · 选区',
        path: '/tmp/spec.pdf'
      }
    ])
    expect(mainComposerScope.$attachments.get()[0]?.refText).toContain('"x": 10')
    expect(mainComposerScope.$attachments.get()[0]?.refText).toContain('"width": 50')

    // Saving an annotation is also a terminal action for the region: the
    // crosshair layer and its old rectangle must not remain active.
    fireEvent.click(rendered.container.querySelector('button[aria-pressed="false"]')!)
    const annotationOverlay = rendered.container.querySelector('.cursor-crosshair') as HTMLDivElement
    Object.defineProperties(annotationOverlay, {
      getBoundingClientRect: {
        value: () => ({ bottom: 200, height: 200, left: 0, right: 400, top: 0, width: 400, x: 0, y: 0 })
      },
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: vi.fn() }
    })
    fireEvent.pointerDown(annotationOverlay, { clientX: 40, clientY: 40, pointerId: 3 })
    fireEvent.pointerMove(annotationOverlay, { clientX: 240, clientY: 140, pointerId: 3 })
    fireEvent.pointerUp(annotationOverlay, { clientX: 240, clientY: 140, pointerId: 3 })
    fireEvent.click(Array.from(rendered.container.querySelectorAll('button')).find(button => button.textContent === '添加批注')!)
    fireEvent.change(rendered.getByPlaceholderText('描述需要关注或修改的内容…'), { target: { value: '检查这个区域' } })
    fireEvent.click(rendered.getByRole('button', { name: '保存批注' }))
    expect(rendered.container.querySelector('.cursor-crosshair')).toBeNull()
    expect(rendered.container.querySelector('button[aria-pressed="false"]')?.textContent).toContain('框选图片/区域并追问')
    await act(() => new Promise(resolve => window.setTimeout(resolve, 5)))
  })

  it('accepts case-insensitive metadata and percent-escaped base64', async () => {
    const readFileDataUrl = vi.fn(async () => 'data:APPLICATION/PDF;BASE64,%4AVBERi0xLjQ=')
    const { createObjectURL } = stubPdfObjectUrls()
    $connection.set({ mode: 'local' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        readFileDataUrl
      }
    })

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'spec.pdf',
            path: '/tmp/spec.pdf',
            previewKind: 'pdf',
            source: '/tmp/spec.pdf',
            url: 'file:///tmp/spec.pdf'
          }}
        />
      )
    })

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1), {
      container: rendered.container
    })
    expect(rendered.container.querySelector('[data-slot="pdf-document-viewer"]')).not.toBeNull()
  })

  it.each([
    ['a non-PDF MIME type', 'data:text/html;base64,JVBERi0xLjQ=', 'Invalid PDF data URL type'],
    ['bytes without a PDF header', 'data:application/pdf;base64,PGh0bWw+', 'Invalid PDF file header'],
    ['a malformed payload', 'data:application/pdf;base64,%', 'Invalid PDF data URL payload']
  ])('rejects %s before creating an object URL', async (_case, dataUrl, expectedError) => {
    const readFileDataUrl = vi.fn(async () => dataUrl)
    const { createObjectURL } = stubPdfObjectUrls()
    $connection.set({ mode: 'local' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        readFileDataUrl
      }
    })

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'spec.pdf',
            path: '/tmp/spec.pdf',
            previewKind: 'pdf',
            source: '/tmp/spec.pdf',
            url: 'file:///tmp/spec.pdf'
          }}
        />
      )
    })

    await waitFor(() => expect(rendered.container.textContent).toContain(expectedError), {
      container: rendered.container
    })
    expect(rendered.container.querySelector('iframe')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('retries a restored PDF when the filesystem connection becomes remote', async () => {
    const filePath = '/remote/spec.pdf'
    const dataUrl = 'data:application/pdf;base64,JVBERi0xLjQ='
    stubPdfObjectUrls()

    const readFileDataUrl = vi.fn(async () => {
      throw new Error('File preview failed: file does not exist')
    })

    const api = vi.fn(async () => dataUrl)
    $connection.set({ mode: 'local' } as never)
    vi.stubGlobal('window', {
      ...window,
      hermesDesktop: {
        api,
        readFileDataUrl
      }
    })

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'file',
            label: 'spec.pdf',
            path: filePath,
            previewKind: 'pdf',
            source: filePath,
            url: `file://${filePath}`
          }}
        />
      )
    })

    await waitFor(() => expect(readFileDataUrl).toHaveBeenCalledTimes(1), { container: rendered.container })

    await act(async () => {
      $connection.set({ baseUrl: 'http://macmini', mode: 'remote', profile: 'macmini' } as never)
    })

    await waitFor(() => expect(rendered.container.querySelector('[data-slot="pdf-document-viewer"]')).not.toBeNull(), {
      container: rendered.container
    })
    expect(api).toHaveBeenCalledWith({
      path: `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`,
      profile: 'macmini'
    })
  })
})
