import { useStore } from '@nanostores/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useFileDropZone } from '@/app/chat/hooks/use-file-drop-zone'
import { type DroppedFile, HERMES_PATHS_MIME } from '@/app/chat/hooks/use-composer-actions'
import { DROP_SHEET_BLUR_CLASS, DROP_SHEET_CLASS } from '@/components/ui/drop-affordance'
import { Codicon } from '@/components/ui/codicon'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Tip } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { isDesktopFsRemoteMode } from '@/lib/desktop-fs'
import { guardGuestPointers } from '@/lib/guest-pointer-guard'
import {
  normalizeOrLocalPreviewTarget,
  openPreviewTargetInBrowser,
  remoteHtmlPreviewDocument
} from '@/lib/local-preview'
import { rafCoalesce } from '@/lib/raf-coalesce'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { $previewServerRestart, failPreviewServerRestart, openPreview, type PreviewTarget } from '@/store/preview'

import { ArtifactPreview } from './preview-artifact'
import {
  clampConsoleHeight,
  compactUrl,
  formatLogLine,
  isNearConsoleBottom,
  PreviewConsolePanel
} from './preview-console'
import { type ConsoleEntry } from './preview-console-state'
import { LocalFilePreview, PreviewEmptyState } from './preview-file'
import { OfficeFilePreview } from './preview-office'
import { registerPreviewPageReader } from './preview-reader'
import { previewConsoleState, registerPreviewDevTools } from './preview-strip-tools'
import { PreviewStart } from './preview-start'
import { PreviewAnnotationHub } from './preview-annotations'

type PreviewWebview = HTMLElement & {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  closeDevTools?: () => void
  executeJavaScript?: (code: string) => Promise<unknown>
  getTitle?: () => string
  getURL?: () => string
  isDevToolsOpened?: () => boolean
  goBack?: () => void
  goForward?: () => void
  loadURL?: (url: string) => Promise<void>
  openDevTools?: () => void
  reload?: () => void
  reloadIgnoringCache?: () => void
}

export function PreviewPane(props: PreviewPaneProps) {
  if (props.target.source === 'preview-start') return <PreviewStartDropZone />

  return (
    <div className="preview-pane-shell relative h-full w-full">
      <PreviewPaneContent {...props} />
      <PreviewAnnotationHub />
    </div>
  )
}

function openDroppedPreviewFiles(files: DroppedFile[]) {
  for (const file of files) {
    if (!file.path || file.isDirectory) continue
    void normalizeOrLocalPreviewTarget(file.path).then(preview => {
      if (preview) openPreview(preview, 'manual')
    })
  }
}

function PreviewStartDropZone() {
  const { t } = useI18n()
  const { dragKind, dropHandlers } = useFileDropZone({ onDropFiles: openDroppedPreviewFiles })

  return (
    <div className="relative h-full w-full" {...dropHandlers}>
      <PreviewStart />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 z-50 grid place-items-center transition-opacity duration-150',
          dragKind === 'files' ? 'opacity-100' : 'opacity-0'
        )}
      >
        <div className={cn(DROP_SHEET_CLASS, DROP_SHEET_BLUR_CLASS, 'absolute inset-2')} />
        <span className="relative text-[11px] font-medium tracking-wide text-foreground">{t.preview.dropToPreview}</span>
      </div>
    </div>
  )
}

interface PreviewPaneProps {
  embedded?: boolean
  onRestartServer?: (url: string, context?: string) => Promise<string>
  reloadRequest?: number
  /** The preview tab this pane renders. Keys the per-tab console store and the
   *  DevTools handle the STRIP glyphs read (see preview-strip-tools). */
  tabId?: string
  target: PreviewTarget
}

interface PreviewLoadErrorState {
  code?: number
  description: string
  url: string
}

const FILE_RELOAD_DEBOUNCE_MS = 200
const SERVER_RESTART_TIMEOUT_MS = 45_000
const PREVIEW_GUEST_FILE_DRAG = '__AGENT_PREVIEW_FILE_DRAG__'

function loadErrorTitle(error: PreviewLoadErrorState, copy: Translations['preview']['web']): string {
  const description = error.description.toLowerCase()

  if (description.includes('module script') || description.includes('mime type')) {
    return copy.appFailedToBoot
  }

  if (description.includes('connection') || description.includes('refused') || description.includes('not found')) {
    return copy.serverNotFound
  }

  return copy.failedToLoad
}

function isModuleMimeError(message: string): boolean {
  const lower = message.toLowerCase()

  return lower.includes('failed to load module script') && lower.includes('mime type')
}

function PreviewLoadError({
  consoleHeight = 0,
  error,
  onRestartServer,
  onRetry,
  restarting
}: {
  consoleHeight?: number
  error: PreviewLoadErrorState
  onRestartServer?: () => void
  onRetry: () => void
  restarting?: boolean
}) {
  const { t } = useI18n()
  const copy = t.preview.web

  return (
    <PreviewEmptyState
      body={
        <>
          <a
            className="pointer-events-auto block font-mono text-muted-foreground/90 underline decoration-current/20 underline-offset-4 transition-colors hover:text-foreground"
            href={error.url}
            onClick={event => {
              event.preventDefault()
              void window.hermesDesktop?.openExternal(error.url)
            }}
          >
            {compactUrl(error.url)}
            {error.code ? ` (${error.code})` : ''}
          </a>
          <div className="mt-1 text-[0.6875rem] text-muted-foreground/70">{error.description}</div>
        </>
      }
      consoleHeight={consoleHeight}
      primaryAction={{ label: copy.tryAgain, onClick: onRetry }}
      secondaryAction={
        onRestartServer
          ? {
              disabled: restarting,
              label: restarting ? copy.restarting : copy.askRestart,
              onClick: onRestartServer
            }
          : undefined
      }
      title={loadErrorTitle(error, copy)}
    />
  )
}

function PreviewPaneContent({ embedded = false, onRestartServer, reloadRequest = 0, tabId, target }: PreviewPaneProps) {
  const { t } = useI18n()
  const paneVisible = usePaneVisible()
  const copy = t.preview.web
  // The console store belongs to the TAB, not this render: the toggles live on
  // the tab and must read the same logs this pane appends to.
  const consoleState = previewConsoleState(tabId ?? target.url)
  const consoleBodyRef = useRef<HTMLDivElement | null>(null)
  const consoleShouldStickRef = useRef(true)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const lastReloadRequestRef = useRef(reloadRequest)
  const lastRestartEventRef = useRef('')
  const previewContentRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<PreviewWebview | null>(null)
  const guestFileDragCleanupRef = useRef<(() => void) | null>(null)
  const previewServerRestart = useStore($previewServerRestart)
  const consoleHeight = useStore(consoleState.$height)
  const consoleOpen = useStore(consoleState.$open)
  const [currentUrl, setCurrentUrl] = useState(target.url)
  const [addressValue, setAddressValue] = useState(target.url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [devtoolsOpen, setDevtoolsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<PreviewLoadErrorState | null>(null)
  const [localReloadKey, setLocalReloadKey] = useState(0)
  const releaseGuestFileDrag = useCallback(() => {
    guestFileDragCleanupRef.current?.()
    guestFileDragCleanupRef.current = null
  }, [])

  const armGuestFileDrag = useCallback(() => {
    if (guestFileDragCleanupRef.current) return

    const releasePointers = guardGuestPointers()
    const finish = () => window.setTimeout(releaseGuestFileDrag, 0)
    const timeout = window.setTimeout(releaseGuestFileDrag, 15_000)

    window.addEventListener('drop', finish, true)
    window.addEventListener('dragend', finish, true)
    guestFileDragCleanupRef.current = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('drop', finish, true)
      window.removeEventListener('dragend', finish, true)
      releasePointers()
    }
  }, [releaseGuestFileDrag])

  useEffect(() => releaseGuestFileDrag, [releaseGuestFileDrag])

  const { dragKind, dropHandlers } = useFileDropZone({
    onDropFiles: files => {
      releaseGuestFileDrag()
      openDroppedPreviewFiles(files)
    }
  })

  // Artifacts have no URL to load — they render from the registry, never in a
  // webview.
  const isWebPreview =
    target.kind !== 'artifact' &&
    (target.kind === 'url' || (target.previewKind === 'html' && target.renderMode !== 'source'))

  const isRemoteHtmlTarget =
    target.kind === 'file' && target.previewKind === 'html' && Boolean(target.dataUrl || target.transient)

  const isRemoteHtml = isRemoteHtmlTarget && target.renderMode !== 'source' && Boolean(target.dataUrl)

  const remoteHtmlDocument = useMemo(
    () => (isRemoteHtml ? remoteHtmlPreviewDocument(target.dataUrl!) : null),
    [isRemoteHtml, target.dataUrl]
  )

  const currentLabel = compactUrl(currentUrl)

  useEffect(() => setAddressValue(currentUrl), [currentUrl])

  const navigateAddress = () => {
    const raw = addressValue.trim()
    if (!raw) return
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`

    try {
      const parsed = new URL(url)
      const webview = webviewRef.current
      if (webview?.loadURL) {
        void webview.loadURL(url)
      } else {
        openPreview({ kind: 'url', label: parsed.hostname, source: url, url }, 'manual')
      }
    } catch {
      notifyError(new Error('请输入有效的网址'), t.preview.unavailable)
    }
  }

  const previewLabel =
    target.label && target.label.replace(/\/$/, '') !== currentLabel.replace(/\/$/, '') ? target.label : currentLabel

  const restartingServer =
    previewServerRestart?.status === 'running' &&
    (previewServerRestart.url === target.url || previewServerRestart.url === currentUrl)

  const startConsoleResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()

      const handle = event.currentTarget
      const pointerId = event.pointerId
      const startY = event.clientY
      const startHeight = consoleHeight
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      let active = true

      handle.setPointerCapture?.(pointerId)

      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      // The webview above the console must not swallow the gesture.
      const releaseGuests = guardGuestPointers()

      // pointermove outpaces 60fps and each setHeight reflows the webview +
      // console split, so coalesce to one apply per frame (commits on cleanup).
      const resize = rafCoalesce((height: number) => consoleState.setHeight(height))

      const handleMove = (moveEvent: PointerEvent) => {
        if (!active) {
          return
        }

        resize.push(clampConsoleHeight(startHeight + startY - moveEvent.clientY))
      }

      const cleanup = () => {
        if (!active) {
          return
        }

        active = false
        resize.finish()
        releaseGuests()
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        handle.releasePointerCapture?.(pointerId)
        window.removeEventListener('pointermove', handleMove, true)
        window.removeEventListener('pointerup', cleanup, true)
        window.removeEventListener('pointercancel', cleanup, true)
        window.removeEventListener('blur', cleanup)
        handle.removeEventListener('lostpointercapture', cleanup)
      }

      window.addEventListener('pointermove', handleMove, true)
      window.addEventListener('pointerup', cleanup, true)
      window.addEventListener('pointercancel', cleanup, true)
      window.addEventListener('blur', cleanup)
      handle.addEventListener('lostpointercapture', cleanup)
    },
    [consoleHeight, consoleState]
  )

  const reloadPreview = useCallback(() => {
    setLoadError(null)

    if (!isWebPreview) {
      setLocalReloadKey(key => key + 1)

      return
    }

    if (webviewRef.current?.reloadIgnoringCache) {
      webviewRef.current.reloadIgnoringCache()
    } else {
      webviewRef.current?.reload?.()
    }
  }, [isWebPreview])

  useEffect(() => {
    if (!paneVisible || target.kind !== 'url') return

    const onRefreshShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'F5') return
      event.preventDefault()
      reloadPreview()
    }

    window.addEventListener('keydown', onRefreshShortcut)
    return () => window.removeEventListener('keydown', onRefreshShortcut)
  }, [paneVisible, reloadPreview, target.kind])

  const appendConsoleEntry = useCallback(
    (entry: Omit<ConsoleEntry, 'id'>) => {
      consoleShouldStickRef.current = isNearConsoleBottom(consoleBodyRef.current)
      consoleState.append(entry)
    },
    [consoleState]
  )

  const restartServer = useCallback(async () => {
    if (!onRestartServer) {
      return
    }

    // Auto-open the preview console so the user can see progress events
    // streaming back from the background agent. Without this, clicking
    // "Ask Hermes to restart the server" looked like it did nothing —
    // the work was happening, but in a collapsed pane.
    consoleState.setOpen(true)

    try {
      const context = consoleState.$logs.get().slice(-12).map(formatLogLine).join('\n')
      const taskId = await onRestartServer(currentUrl, context || undefined)

      appendConsoleEntry({
        level: 1,
        message: copy.lookingRestart(taskId)
      })

      notify({
        kind: 'info',
        title: copy.restartingTitle,
        message: copy.restartingMessage,
        durationMs: 4000
      })
    } catch (error) {
      appendConsoleEntry({
        level: 2,
        message: copy.startRestartFailed(error instanceof Error ? error.message : String(error))
      })
      notifyError(error, copy.restartFailed)
    }
  }, [appendConsoleEntry, consoleState, copy, currentUrl, onRestartServer])

  const toggleDevTools = useCallback(() => {
    const webview = webviewRef.current

    if (!webview?.openDevTools) {
      return
    }

    if (webview.isDevToolsOpened?.()) {
      webview.closeDevTools?.()

      return
    }

    webview.openDevTools()
  }, [])

  // Publish the DevTools handle for THIS tab so the tab's own toggle can drive
  // the webview (which only exists in here). Registered on every open/close
  // change so the button's active state stays truthful.
  useEffect(() => {
    if (!isWebPreview || !tabId) {
      return
    }

    // Remote HTML renders in a sandboxed iframe, not a webview — there is no
    // console and no DevTools to offer (same guard the titlebar tools had).
    if (isRemoteHtml) {
      return
    }

    registerPreviewDevTools(tabId, { open: devtoolsOpen, toggle: toggleDevTools })

    return () => registerPreviewDevTools(tabId, null)
  }, [devtoolsOpen, isRemoteHtml, isWebPreview, tabId, toggleDevTools])

  // Publish the PAGE reader for this tab (the read_preview tool): extract the
  // rendered page's title + visible text from the webview. innerText (not
  // textContent) so hidden nodes and script/style bodies stay out, matching
  // what the user actually sees.
  useEffect(() => {
    if (!isWebPreview || !tabId) {
      return
    }

    return registerPreviewPageReader(tabId, async () => {
      const webview = webviewRef.current

      if (!webview?.executeJavaScript) {
        throw new Error('preview webview is not ready')
      }

      const text = await webview.executeJavaScript('document.body ? document.body.innerText : ""')

      return {
        text: typeof text === 'string' ? text : '',
        title: webview.getTitle?.() ?? '',
        url: webview.getURL?.() ?? ''
      }
    })
  }, [isWebPreview, tabId])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!consoleOpen) {
      return
    }

    consoleShouldStickRef.current = true

    const handle = window.requestAnimationFrame(() => {
      const consoleBody = consoleBodyRef.current
      consoleBody?.scrollTo({ top: consoleBody.scrollHeight })
    })

    return () => window.cancelAnimationFrame(handle)
  }, [consoleOpen])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (
      !previewServerRestart ||
      !previewServerRestart.message ||
      (previewServerRestart.url !== target.url && previewServerRestart.url !== currentUrl)
    ) {
      return
    }

    const eventKey = `${previewServerRestart.taskId}:${previewServerRestart.status}:${previewServerRestart.message || ''}`

    if (eventKey === lastRestartEventRef.current) {
      return
    }

    lastRestartEventRef.current = eventKey
    appendConsoleEntry({
      level: previewServerRestart.status === 'error' ? 2 : 1,
      message:
        previewServerRestart.status === 'running'
          ? previewServerRestart.message
          : previewServerRestart.status === 'complete'
            ? copy.finishedRestarting(previewServerRestart.message)
            : copy.failedRestarting(previewServerRestart.message || copy.unknownError)
    })

    if (previewServerRestart.status === 'complete') {
      reloadPreview()
      notify({
        kind: 'success',
        title: copy.restartedTitle,
        message: previewServerRestart.message?.slice(0, 160) || copy.reloadingNow,
        durationMs: 3500
      })
    } else if (previewServerRestart.status === 'error') {
      notify({
        kind: 'warning',
        title: copy.restartFailedTitle,
        message: previewServerRestart.message?.slice(0, 200) || copy.restartFailedMessage,
        durationMs: 6000
      })
    }
  }, [appendConsoleEntry, copy, currentUrl, previewServerRestart, reloadPreview, target.url])

  useEffect(() => {
    if (!restartingServer || !previewServerRestart) {
      return
    }

    const taskId = previewServerRestart.taskId

    const timer = window.setTimeout(() => {
      failPreviewServerRestart(taskId, copy.stillWorking)
    }, SERVER_RESTART_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [copy.stillWorking, previewServerRestart, restartingServer])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (reloadRequest === lastReloadRequestRef.current) {
      return
    }

    lastReloadRequestRef.current = reloadRequest

    if (target.kind !== 'url') {
      return
    }

    appendConsoleEntry({
      level: 1,
      message: copy.workspaceReloading
    })
    reloadPreview()
  }, [appendConsoleEntry, copy.workspaceReloading, reloadPreview, reloadRequest, target.kind])

  useEffect(() => {
    if (
      target.kind !== 'file' ||
      isDesktopFsRemoteMode() ||
      !window.hermesDesktop?.watchPreviewFile ||
      !window.hermesDesktop?.onPreviewFileChanged
    ) {
      return
    }

    let active = true
    let pendingReloadCount = 0
    let pendingReloadUrl = ''
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    let watchId = ''

    const flushReload = () => {
      if (!active || pendingReloadCount === 0) {
        return
      }

      const changedCount = pendingReloadCount
      const changedUrl = pendingReloadUrl

      pendingReloadCount = 0
      pendingReloadUrl = ''

      appendConsoleEntry({
        level: 1,
        message:
          changedCount === 1
            ? copy.fileChanged(compactUrl(changedUrl))
            : copy.filesChanged(changedCount, compactUrl(changedUrl))
      })

      reloadPreview()
    }

    const unsubscribe = window.hermesDesktop.onPreviewFileChanged(payload => {
      if (!active || payload.id !== watchId) {
        return
      }

      pendingReloadCount += 1
      pendingReloadUrl = payload.url

      if (reloadTimer) {
        clearTimeout(reloadTimer)
      }

      reloadTimer = setTimeout(() => {
        reloadTimer = null
        flushReload()
      }, FILE_RELOAD_DEBOUNCE_MS)
    })

    void window.hermesDesktop
      .watchPreviewFile(target.url)
      .then(watch => {
        if (!active) {
          void window.hermesDesktop?.stopPreviewFileWatch?.(watch.id)

          return
        }

        watchId = watch.id
      })
      .catch(error => {
        appendConsoleEntry({
          level: 2,
          message: copy.watchFailed(error instanceof Error ? error.message : String(error))
        })
      })

    return () => {
      active = false
      unsubscribe()

      if (reloadTimer) {
        clearTimeout(reloadTimer)
      }

      if (watchId) {
        void window.hermesDesktop?.stopPreviewFileWatch?.(watchId)
      }
    }
  }, [appendConsoleEntry, copy, reloadPreview, target.kind, target.url])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    host.replaceChildren()
    webviewRef.current = null
    setCurrentUrl(target.url)
    setCanGoBack(false)
    setCanGoForward(false)
    setDevtoolsOpen(false)
    setLoadError(null)
    consoleState.reset()
    setLoading(true)

    if (!isWebPreview || isRemoteHtml) {
      setLoading(false)

      return
    }

    const webview = document.createElement('webview') as PreviewWebview
    webview.className = 'absolute inset-0 block h-full w-full min-h-0 min-w-0 bg-transparent'
    // Lets target=_blank reach the main-process handler. That handler always
    // denies creating a popup and safely reuses this same preview guest.
    webview.setAttribute('allowpopups', '')
    webview.setAttribute('partition', 'persist:hermes-preview')
    webview.setAttribute('src', target.url)
    webview.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes')

    const onConsole = (event: Event) => {
      const detail = event as Event & {
        level?: number
        line?: number
        message?: string
        sourceId?: string
      }

      const message = detail.message || ''

      if (message === PREVIEW_GUEST_FILE_DRAG) {
        armGuestFileDrag()
        return
      }

      appendConsoleEntry({
        level: detail.level ?? 0,
        line: detail.line,
        message,
        source: detail.sourceId
      })

      if ((detail.level ?? 0) >= 3 && isModuleMimeError(message)) {
        setLoadError({
          description: copy.moduleMimeDescription,
          url: webview.getURL?.() || target.url
        })
        setLoading(false)
      }
    }

    const onNavigate = (event: Event) => {
      const detail = event as Event & { url?: string }

      if (detail.url) {
        setLoadError(null)
        setCurrentUrl(detail.url)
      }
      setCanGoBack(Boolean(webview.canGoBack?.()))
      setCanGoForward(Boolean(webview.canGoForward?.()))
    }

    const onNewWindow = (event: Event) => {
      const detail = event as Event & { preventDefault?: () => void; url?: string }
      if (!detail.url || !/^https?:\/\//i.test(detail.url)) return
      detail.preventDefault?.()
      setCurrentUrl(detail.url)
      void webview.loadURL?.(detail.url)
    }

    const onFail = (event: Event) => {
      const detail = event as Event & {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
      }

      const errorCode = detail.errorCode

      if (errorCode === -3) {
        return
      }

      appendConsoleEntry({
        level: 3,
        message: copy.loadFailedConsole(errorCode, detail.errorDescription || detail.validatedURL || copy.unknownError)
      })
      setLoadError({
        code: errorCode,
        description: detail.errorDescription || copy.unreachableDescription,
        url: detail.validatedURL || webview.getURL?.() || target.url
      })
      setLoading(false)
    }

    const onStart = () => setLoading(true)
    const onStop = () => setLoading(false)
    // The WEBVIEW is the source of truth for DevTools, not our click handler:
    // closing the DevTools window itself fires devtools-closed with no click,
    // and the glyph was left stuck "on" when we tracked it locally.
    const onDevToolsOpened = () => setDevtoolsOpen(true)
    const onDevToolsClosed = () => setDevtoolsOpen(false)
    const onDomReady = () => {
      void webview.executeJavaScript?.(`(() => {
        if (window.__agentPreviewFileDragBridge) return
        window.__agentPreviewFileDragBridge = true
        document.addEventListener('dragenter', event => {
          const types = Array.from(event.dataTransfer?.types || [])
          if (types.includes('Files') || types.includes('${HERMES_PATHS_MIME}')) {
            console.info('${PREVIEW_GUEST_FILE_DRAG}')
          }
        }, true)
      })()`)
    }

    webview.addEventListener('console-message', onConsole)
    webview.addEventListener('devtools-closed', onDevToolsClosed)
    webview.addEventListener('devtools-opened', onDevToolsOpened)
    webview.addEventListener('did-fail-load', onFail)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    host.appendChild(webview)
    webviewRef.current = webview

    return () => {
      webview.removeEventListener('console-message', onConsole)
      webview.removeEventListener('devtools-closed', onDevToolsClosed)
      webview.removeEventListener('devtools-opened', onDevToolsOpened)
      webview.removeEventListener('did-fail-load', onFail)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', onStop)
      webview.remove()
    }
  }, [appendConsoleEntry, armGuestFileDrag, consoleState, copy, isRemoteHtml, isWebPreview, target.url])

  return (
    <aside
      className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-transparent text-muted-foreground"
      {...dropHandlers}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 z-50 grid place-items-center transition-opacity duration-150',
          dragKind === 'files' ? 'opacity-100' : 'opacity-0'
        )}
      >
        <div className={cn(DROP_SHEET_CLASS, DROP_SHEET_BLUR_CLASS, 'absolute inset-2')} />
        <span className="relative text-[11px] font-medium tracking-wide text-foreground">{t.preview.dropToPreview}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {target.kind === 'url' && (
          <form className="preview-web-address-bar" onSubmit={event => { event.preventDefault(); navigateAddress() }}>
            <button
              aria-label="后退"
              className="preview-web-navigation-button"
              disabled={!canGoBack}
              onClick={() => webviewRef.current?.goBack?.()}
              title="后退"
              type="button"
            >
              <Codicon name="arrow-left" size="0.8125rem" />
            </button>
            <button
              aria-label="前进"
              className="preview-web-navigation-button"
              disabled={!canGoForward}
              onClick={() => webviewRef.current?.goForward?.()}
              title="前进"
              type="button"
            >
              <Codicon name="arrow-right" size="0.8125rem" />
            </button>
            <button
              aria-label="刷新"
              className="preview-web-navigation-button"
              onClick={reloadPreview}
              title="刷新 (F5)"
              type="button"
            >
              <Codicon name="refresh" size="0.8125rem" />
            </button>
            <input aria-label="网页地址" onChange={event => setAddressValue(event.target.value)} value={addressValue} />
            <button type="submit">前往</button>
          </form>
        )}
        {!embedded && (
          <div className="pointer-events-none flex min-h-(--titlebar-height) items-center gap-1.5 border-b border-border/60 bg-background px-2 py-1">
            <div className="min-w-0 flex-1">
              <Tip label={copy.openTarget(currentUrl)}>
                <a
                  className="pointer-events-auto inline max-w-full truncate text-left text-xs font-medium text-foreground underline-offset-4 decoration-current/20 transition-colors hover:text-primary hover:underline"
                  href={isRemoteHtmlTarget ? undefined : currentUrl}
                  onClick={event => {
                    if (isRemoteHtmlTarget) {
                      event.preventDefault()
                      void openPreviewTargetInBrowser(target).catch(error => notifyError(error, t.preview.unavailable))
                    }
                  }}
                  rel="noreferrer"
                  target={isRemoteHtmlTarget ? undefined : '_blank'}
                >
                  {previewLabel || copy.fallbackTitle}
                </a>
              </Tip>
            </div>
          </div>
        )}

        <div
          className="pointer-events-auto relative min-h-0 flex-1 overflow-hidden bg-transparent"
          ref={previewContentRef}
        >
          <div
            className={cn(
              'absolute inset-0 flex bg-transparent',
              (isRemoteHtml || !isWebPreview || loadError) && 'pointer-events-none opacity-0'
            )}
            ref={hostRef}
          />
          {isRemoteHtml && (
            <iframe
              className="absolute inset-0 size-full border-0 bg-white"
              referrerPolicy="no-referrer"
              sandbox=""
              srcDoc={remoteHtmlDocument || ''}
              title={target.label || copy.fallbackTitle}
            />
          )}
          {!isWebPreview &&
            (target.kind === 'artifact' ? (
              <ArtifactPreview target={target} />
            ) : target.previewKind === 'office' ? (
              <OfficeFilePreview target={target} />
            ) : (
              <LocalFilePreview reloadKey={localReloadKey} target={target} />
            ))}
          {loadError && (
            <PreviewLoadError
              consoleHeight={consoleOpen ? consoleHeight : 0}
              error={loadError}
              onRestartServer={target.kind === 'url' && onRestartServer ? () => void restartServer() : undefined}
              onRetry={reloadPreview}
              restarting={restartingServer}
            />
          )}

          {isWebPreview && !isRemoteHtml && consoleOpen && (
            <PreviewConsolePanel
              consoleBodyRef={consoleBodyRef}
              consoleShouldStickRef={consoleShouldStickRef}
              consoleState={consoleState}
              startConsoleResize={startConsoleResize}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
