import { ExportedMessageRepository } from '@assistant-ui/react'
// Clicking a user bubble must open the inline edit composer — through the
// app's incremental external-store runtime (which reimplements capability
// resolution, incl. `edit: onEdit !== undefined`) and the stock runtime.
//
// Note: this covers the React/runtime wiring only. The Electron-level failure
// mode (titlebar -webkit-app-region:drag swallowing clicks on *stuck* sticky
// bubbles) is not reproducible in jsdom — see USER_BUBBLE_BASE_CLASS's no-drag
// carve-out in thread.tsx.
import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'

import { Thread } from '.'

const createdAt = new Date('2026-05-01T00:00:00.000Z')

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

afterEach(() => {
  cleanup()
})

function stubOffsetDimension(
  prop: 'offsetHeight' | 'offsetWidth',
  clientProp: 'clientHeight' | 'clientWidth',
  fallback: number
) {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)

  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return previous?.get?.call(this) || (this as HTMLElement)[clientProp] || fallback
    }
  })
}

stubOffsetDimension('offsetWidth', 'clientWidth', 800)
stubOffsetDimension('offsetHeight', 'clientHeight', 600)

async function moveFocusOutside(editor: HTMLElement) {
  const outside = window.document.createElement('button')
  window.document.body.append(outside)
  editor.focus()

  await act(async () => {
    outside.focus()
    await new Promise(resolve => window.setTimeout(resolve, 120))
  })

  outside.remove()
}

function userMessage(text = 'edit me please'): ThreadMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function assistantMessage(): ThreadMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as ThreadMessage
}

// Mirrors chat/index.tsx: incremental runtime + messageRepository + onEdit.
function IncrementalHarness({ onEdit, text }: { onEdit: () => Promise<void>; text?: string }) {
  const repository = ExportedMessageRepository.fromArray([userMessage(text), assistantMessage()])

  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: repository,
    isRunning: false,
    setMessages: () => {},
    onNew: async () => {},
    onEdit,
    onCancel: async () => {},
    onReload: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

// Control: stock external store runtime.
function StockHarness({ onEdit }: { onEdit: () => Promise<void> }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [userMessage(), assistantMessage()],
    isRunning: false,
    onNew: async () => {},
    onEdit
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

describe('click-to-edit user message', () => {
  it('renders preview selection payloads as removable cards while editing', async () => {
    const selectionText =
      '请修改这里\n\n<preview_selection>\n{"type":"preview-annotation-collection","format":"pdf","path":"/tmp/GuideLine.pdf","label":"GuideLine.pdf · 第 1 页","annotations":[{"note":"保留背景去掉"}]}\n</preview_selection>'
    const { container } = render(<IncrementalHarness onEdit={async () => {}} text={selectionText} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))

    const editor = await screen.findByRole('textbox', { name: 'Edit message' })

    expect(editor.textContent).toBe('请修改这里')
    expect(container.querySelector('[data-slot="preview-selection-card"]')).toBeTruthy()
    expect(screen.queryByText(/preview-annotation-collection/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '移除选取信息' }))
    expect(container.querySelector('[data-slot="preview-selection-card"]')).toBeFalsy()
  })

  it('opens the edit composer with the incremental runtime', async () => {
    const { container } = render(<IncrementalHarness onEdit={async () => {}} />)

    const bubble = await screen.findByRole('button', { name: 'Edit message' })

    fireEvent.click(bubble)

    await waitFor(() => {
      expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeTruthy()
    })
  })

  it('cancels a dirty inline edit when focus leaves the composer', async () => {
    const { container } = render(<IncrementalHarness onEdit={async () => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))

    const editor = await screen.findByRole('textbox', { name: 'Edit message' })
    const editedText = 'edited draft that must not be discarded'

    editor.textContent = editedText
    fireEvent.input(editor)
    await moveFocusOutside(editor)

    expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeFalsy()
  })

  it('still cancels an untouched inline edit when focus leaves the composer', async () => {
    const { container } = render(<IncrementalHarness onEdit={async () => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit message' })

    await moveFocusOutside(editor)

    expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeFalsy()
  })

  it('opens the edit composer with the stock runtime', async () => {
    const { container } = render(<StockHarness onEdit={async () => {}} />)

    const bubble = await screen.findByRole('button', { name: 'Edit message' })

    fireEvent.click(bubble)

    await waitFor(() => {
      expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeTruthy()
    })
  })
})
