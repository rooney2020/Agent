import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { mainComposerScope } from '@/store/composer'
import { requestPreviewAnnotation } from '@/store/preview-annotations'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface PdfSelection {
  page: number
  selectionType: 'image' | 'text'
  text?: string
}

async function dataUrlBytes(dataUrl: string) {
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`PDF 数据读取失败：${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const MAX_CONCURRENT_PAGE_RENDERS = 2
let activePageRenders = 0
const pendingPageRenders: (() => void)[] = []

function schedulePageRender<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activePageRenders += 1
      void work()
        .then(resolve, reject)
        .finally(() => {
          activePageRenders -= 1
          pendingPageRenders.shift()?.()
        })
    }

    if (activePageRenders < MAX_CONCURRENT_PAGE_RENDERS) start()
    else pendingPageRenders.push(start)
  })
}

function PdfPage({ pdf, pageNumber, onSelect }: { pdf: any; pageNumber: number; onSelect: (value: PdfSelection) => void }) {
  const hostRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [page, setPage] = useState<any>(null)
  const [size, setSize] = useState({ height: 1136, width: 803 })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const observer = new IntersectionObserver(entries => setNearViewport(entries[0]?.isIntersecting === true), {
      rootMargin: '1400px 0px'
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!nearViewport) {
      setPage(null)
      return
    }

    let cancelled = false
    void pdf.getPage(pageNumber).then((next: any) => {
      if (cancelled) {
        next.cleanup?.()
        return
      }
      const viewport = next.getViewport({ scale: 1.35 })
      setSize({ height: viewport.height, width: viewport.width })
      setPage(next)
    })

    return () => {
      cancelled = true
    }
  }, [nearViewport, pageNumber, pdf])

  useEffect(() => {
    const canvas = canvasRef.current
    const textHost = textRef.current

    if (!canvas || !textHost || !page || !nearViewport) return
    let cancelled = false
    const viewport = page.getViewport({ scale: 1.35 })
    const outputScale = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    textHost.style.width = `${viewport.width}px`
    textHost.style.height = `${viewport.height}px`
    textHost.style.setProperty('--total-scale-factor', String(viewport.scale))
    const context = canvas.getContext('2d')

    if (!context) return
    let renderTask: ReturnType<typeof page.render> | undefined
    let textLayer: TextLayer | undefined

    void schedulePageRender(async () => {
      if (cancelled) return
      renderTask = page.render({ canvas, canvasContext: context, transform: [outputScale, 0, 0, outputScale, 0, 0], viewport })
      await renderTask.promise
      if (!cancelled) {
        if (cancelled) return
        textHost.replaceChildren()
        textLayer = new TextLayer({ container: textHost, textContentSource: await page.getTextContent(), viewport })
        await textLayer.render()
      }
    })
      .catch((reason: unknown) => {
        if (!cancelled && (!(reason instanceof Error) || reason.name !== 'RenderingCancelledException')) throw reason
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      textHost.replaceChildren()
      canvas.width = 0
      canvas.height = 0
      page.cleanup?.()
    }
  }, [nearViewport, page])

  return (
    <section
      className="pdf-page"
      data-page-loaded={page ? 'true' : undefined}
      data-page-number={pageNumber}
      ref={hostRef}
      style={{ height: size.height, width: size.width }}
    >
      <canvas
        aria-label={`第 ${pageNumber} 页图像`}
        className="pdf-page-canvas"
        onClick={() => {
          const selection = window.getSelection()

          if (!selection?.toString().trim()) onSelect({ page: pageNumber, selectionType: 'image' })
        }}
        ref={canvasRef}
      />
      <div
        className="pdf-text-layer"
        onMouseUp={() => {
          const selection = window.getSelection()
          const text = selection?.toString().trim()

          if (text && selection?.anchorNode && textRef.current?.contains(selection.anchorNode)) {
            onSelect({ page: pageNumber, selectionType: 'text', text })
          }
        }}
        ref={textRef}
      />
    </section>
  )
}

export function PdfDocumentPreview({ dataUrl, filePath, label }: { dataUrl: string; filePath: string; label: string }) {
  const [documentState, setDocumentState] = useState<{ numPages: number; pdf: any } | null>(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<PdfSelection | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | null = null

    void dataUrlBytes(dataUrl)
      .then(bytes => {
        if (cancelled) return null
        task = getDocument({ data: bytes })
        return task.promise
      })
      .then(pdf => {
        if (pdf && !cancelled) setDocumentState({ numPages: pdf.numPages, pdf })
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })

    return () => {
      cancelled = true
      if (task) void task.destroy()
    }
  }, [dataUrl])

  const attach = () => {
    if (!selection) return
    const locator = {
      type: 'preview-pdf-element',
      format: 'pdf',
      path: filePath,
      page: selection.page,
      selectionType: selection.selectionType,
      ...(selection.text ? { text: selection.text } : {})
    }
    const refText = `\n\n<preview_selection>\n${JSON.stringify(locator, null, 2)}\n</preview_selection>`

    mainComposerScope.add({
      id: `pdf:${filePath}:${selection.page}:${selection.selectionType}:${selection.text || 'page'}`,
      kind: 'selection',
      label: `${label} · 第 ${selection.page} 页 · ${selection.selectionType === 'text' ? selection.text?.slice(0, 28) : '页面图像'}`,
      detail: `PDF · 第 ${selection.page} 页`,
      path: filePath,
      refText
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    requestComposerFocus('main')
  }

  const annotate = () => {
    if (!selection) return
    requestPreviewAnnotation({
      label: `${label} · 第 ${selection.page} 页 · ${selection.selectionType === 'text' ? selection.text?.slice(0, 28) : '页面图像'}`,
      onSaved: () => {
        setSelection(null)
        window.getSelection()?.removeAllRanges()
      },
      path: filePath,
      locator: {
        type: 'preview-pdf-element', format: 'pdf', path: filePath, page: selection.page,
        selectionType: selection.selectionType, ...(selection.text ? { text: selection.text } : {})
      }
    })
  }

  if (error) return <div className="p-6 text-sm text-destructive" data-slot="pdf-document-viewer">PDF 加载失败：{error}</div>
  if (!documentState) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-slot="pdf-document-viewer">正在加载 PDF…</div>

  return (
    <div className="pdf-document-viewer" data-slot="pdf-document-viewer">
      {selection && (
        <div className="pdf-selection-toolbar">
          <span>{`第 ${selection.page} 页 · ${selection.selectionType === 'text' ? selection.text?.slice(0, 36) : '页面图像'}`}</span>
          <button onClick={attach} type="button">引用并追问</button>
          <button className="preview-selection-annotate" onClick={annotate} type="button">添加批注</button>
          <button aria-label="取消选择" onClick={() => setSelection(null)} type="button">×</button>
        </div>
      )}
      <div className="pdf-pages">
        {Array.from({ length: documentState.numPages }, (_, index) => (
          <PdfPage key={index} onSelect={setSelection} pdf={documentState.pdf} pageNumber={index + 1} />
        ))}
      </div>
    </div>
  )
}
