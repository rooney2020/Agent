import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  textRender: vi.fn(async () => undefined)
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: pdfMocks.getDocument,
  TextLayer: class {
    cancel = vi.fn()
    render = pdfMocks.textRender
  }
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf-worker.js' }))

import { PdfDocumentPreview } from './preview-pdf'

describe('PdfDocumentPreview virtualization', () => {
  const observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
  const pages = Array.from({ length: 12 }, (_, index) => ({
    cleanup: vi.fn(),
    getTextContent: vi.fn(async () => ({ items: [] })),
    getViewport: vi.fn(() => ({ height: 1000, scale: 1.35, width: 700 })),
    pageNumber: index + 1,
    render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }))
  }))
  const pdf = {
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
    numPages: pages.length
  }

  beforeEach(() => {
    observers.length = 0
    vi.clearAllMocks()
    pdfMocks.getDocument.mockReturnValue({ destroy: vi.fn(), promise: Promise.resolve(pdf) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        callback: IntersectionObserverCallback
        disconnect = vi.fn()
        observe = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback
          observers.push(this)
        }
      }
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  })

  it('creates lightweight placeholders and loads only pages near the viewport', async () => {
    const rendered = render(
      <PdfDocumentPreview dataUrl="data:application/pdf;base64,AA==" filePath="/tmp/large.pdf" label="large.pdf" />
    )

    await waitFor(() => expect(rendered.container.querySelectorAll('.pdf-page')).toHaveLength(12))
    expect(pdf.getPage).not.toHaveBeenCalled()

    await act(async () => {
      observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], observers[0] as never)
    })

    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledTimes(1))
    expect(pdf.getPage).toHaveBeenCalledWith(1)
    expect(pages[0].render).toHaveBeenCalledOnce()
    expect(rendered.container.querySelectorAll('[data-page-loaded=true]')).toHaveLength(1)

    await act(async () => {
      observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], observers[0] as never)
    })

    await waitFor(() => expect(pages[0].cleanup).toHaveBeenCalled())
    expect(rendered.container.querySelectorAll('[data-page-loaded=true]')).toHaveLength(0)
  })
})
