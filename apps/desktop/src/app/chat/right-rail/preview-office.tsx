import DOMPurify from 'dompurify'
import { useEffect, useRef, useState } from 'react'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import type { PreviewTarget } from '@/store/preview'
import { mainComposerScope } from '@/store/composer'
import { requestPreviewAnnotation } from '@/store/preview-annotations'

import { PreviewEmptyState } from './preview-file'

function extension(target: PreviewTarget): string {
  const value = target.path || target.source
  const match = value.toLowerCase().match(/\.[a-z0-9]+$/)

  return match?.[0] || ''
}

function dataUrlBytes(dataUrl: string): ArrayBuffer {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const decoded = atob(encoded)
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))

  return bytes.buffer
}

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A'

  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

function columnName(index: number): string {
  let value = index + 1
  let name = ''

  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }

  return name
}

type SpreadsheetCellStyle = {
  alignment?: string
  background?: string
  borderBottom?: string
  borderLeft?: string
  borderRight?: string
  borderTop?: string
  color?: string
  fontFamily?: string
  fontSize?: string
  fontStyle?: string
  fontWeight?: string
  textDecoration?: string
  verticalAlign?: string
  whiteSpace?: string
}

function directChildren(parent: Element | undefined, name: string): Element[] {
  return parent ? [...parent.children].filter(child => child.localName === name) : []
}

function xlsxColor(node: Element | undefined): string | undefined {
  const rgb = node?.getAttribute('rgb')

  if (!rgb) return undefined

  return `#${rgb.length === 8 ? rgb.slice(2) : rgb}`
}

function borderCss(side: Element | undefined): string | undefined {
  if (!side?.getAttribute('style')) return undefined

  const widths: Record<string, number> = { hair: 1, thin: 1, medium: 2, thick: 3, double: 3 }
  const style = side.getAttribute('style') || 'thin'
  const line = style === 'dashed' || style === 'dotted' ? style : style === 'double' ? 'double' : 'solid'

  return `${widths[style] || 1}px ${line} ${xlsxColor(side.getElementsByTagName('color')[0]) || '#808080'}`
}

function parseCellStyles(stylesXml: string | undefined): SpreadsheetCellStyle[] {
  if (!stylesXml) return []

  const xml = parseXml(stylesXml)
  const fonts = directChildren(xml.getElementsByTagName('fonts')[0], 'font')
  const fills = directChildren(xml.getElementsByTagName('fills')[0], 'fill')
  const borders = directChildren(xml.getElementsByTagName('borders')[0], 'border')
  const xfs = directChildren(xml.getElementsByTagName('cellXfs')[0], 'xf')

  return xfs.map(xf => {
    const font = fonts[Number(xf.getAttribute('fontId') || 0)]
    const fill = fills[Number(xf.getAttribute('fillId') || 0)]
    const border = borders[Number(xf.getAttribute('borderId') || 0)]
    const alignment = xf.getElementsByTagName('alignment')[0]
    const fontSize = font?.getElementsByTagName('sz')[0]?.getAttribute('val')
    const family = font?.getElementsByTagName('name')[0]?.getAttribute('val')
    const pattern = fill?.getElementsByTagName('patternFill')[0]
    const fillColor =
      pattern?.getAttribute('patternType') === 'solid'
        ? xlsxColor(pattern.getElementsByTagName('fgColor')[0])
        : undefined
    const horizontal: Record<string, string> = {
      center: 'center',
      centerContinuous: 'center',
      distributed: 'justify',
      fill: 'left',
      general: 'left',
      justify: 'justify',
      left: 'left',
      right: 'right'
    }
    const vertical: Record<string, string> = { bottom: 'bottom', center: 'middle', distributed: 'middle', top: 'top' }

    return {
      alignment: horizontal[alignment?.getAttribute('horizontal') || ''],
      background: fillColor,
      borderBottom: borderCss(border?.getElementsByTagName('bottom')[0]),
      borderLeft: borderCss(border?.getElementsByTagName('left')[0]),
      borderRight: borderCss(border?.getElementsByTagName('right')[0]),
      borderTop: borderCss(border?.getElementsByTagName('top')[0]),
      color: xlsxColor(font?.getElementsByTagName('color')[0]),
      fontFamily: family ? `${JSON.stringify(family)}, sans-serif` : undefined,
      fontSize: fontSize ? `${Number(fontSize) * (4 / 3)}px` : undefined,
      fontStyle: font?.getElementsByTagName('i').length ? 'italic' : undefined,
      fontWeight: font?.getElementsByTagName('b').length ? '700' : undefined,
      textDecoration: font?.getElementsByTagName('u').length ? 'underline' : undefined,
      verticalAlign: vertical[alignment?.getAttribute('vertical') || ''],
      whiteSpace: alignment?.getAttribute('wrapText') === '1' ? 'pre-wrap' : 'nowrap'
    }
  })
}

function applyCellStyle(cell: HTMLElement, style: SpreadsheetCellStyle | undefined) {
  if (!style) return

  Object.assign(cell.style, {
    background: style.background,
    borderBottom: style.borderBottom,
    borderLeft: style.borderLeft,
    borderRight: style.borderRight,
    borderTop: style.borderTop,
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    textAlign: style.alignment,
    textDecoration: style.textDecoration,
    verticalAlign: style.verticalAlign,
    whiteSpace: style.whiteSpace
  })
}

function cellReference(reference: string): { column: number; row: number } {
  return {
    column: columnIndex(reference),
    row: Math.max(0, Number(reference.match(/\d+$/)?.[0] || 1) - 1)
  }
}

function installDocxSelection(host: HTMLElement, target: PreviewTarget): () => void {
  host.classList.add('office-document-workspace')
  const toolbar = document.createElement('div')
  toolbar.className = 'office-document-selection-toolbar'
  toolbar.hidden = true
  const label = document.createElement('span')
  const cite = document.createElement('button')
  cite.type = 'button'
  cite.textContent = '引用并追问'
  const annotate = document.createElement('button')
  annotate.type = 'button'
  annotate.textContent = '添加批注'
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = '取消'
  toolbar.append(label, cite, annotate, clear)
  host.appendChild(toolbar)

  type DocumentSelection = { element: HTMLElement; elementIndex: number; selectionType: 'element' | 'image' | 'text'; text: string }
  let current: DocumentSelection | null = null
  const selectableSelector = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, img, svg, canvas'
  const clearSelection = () => {
    host.querySelectorAll('[data-docx-selected]').forEach(element => element.removeAttribute('data-docx-selected'))
    current = null
    toolbar.hidden = true
  }
  const selectElement = (element: HTMLElement, selectionType: DocumentSelection['selectionType'], text: string) => {
    host.querySelectorAll('[data-docx-selected]').forEach(candidate => candidate.removeAttribute('data-docx-selected'))
    element.dataset.docxSelected = 'true'
    const elements = [
      ...host.querySelectorAll<HTMLElement>(selectionType === 'image' ? 'img, svg, canvas' : selectableSelector)
    ]
    current = { element, elementIndex: Math.max(0, elements.indexOf(element)), selectionType, text: text.trim() }
    label.textContent = selectionType === 'image' ? `图片 ${current.elementIndex + 1}` : current.text.slice(0, 36) || element.tagName
    toolbar.hidden = false
  }
  const onMouseUp = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim() || ''
    const anchor = selection?.anchorNode

    if (!text || !anchor || !host.contains(anchor)) return

    const anchorElement = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
    const element = anchorElement?.closest<HTMLElement>(selectableSelector)

    if (element && host.contains(element)) selectElement(element, 'text', text)
  }
  const onClick = (event: MouseEvent) => {
    const targetElement = event.target as HTMLElement

    if (targetElement.closest('.office-document-selection-toolbar')) return

    const element = targetElement.closest<HTMLElement>(selectableSelector)

    if (!element || !host.contains(element)) return

    if (element.matches('img, svg, canvas')) {
      selectElement(element, 'image', element.getAttribute('alt') || '')
    } else if (!window.getSelection()?.toString().trim()) {
      selectElement(element, 'element', element.textContent || '')
    }
  }

  host.addEventListener('mouseup', onMouseUp)
  host.addEventListener('click', onClick)
  clear.addEventListener('click', () => {
    window.getSelection()?.removeAllRanges()
    clearSelection()
  })
  cite.addEventListener('click', () => {
    if (!current) return

    const locator = {
      type: 'preview-document-element',
      format: 'docx',
      path: target.path || target.source,
      selectionType: current.selectionType,
      elementTag: current.element.tagName.toLowerCase(),
      elementIndex: current.elementIndex,
      text: current.text
    }
    const refText = `\n\n<preview_selection>\n${JSON.stringify(locator, null, 2)}\n</preview_selection>`

    mainComposerScope.add({
      id: `document:${locator.path}:${locator.elementTag}:${locator.elementIndex}:${locator.selectionType}`,
      kind: 'selection',
      label: `${target.label} · ${current.selectionType === 'image' ? `图片 ${current.elementIndex + 1}` : current.text.slice(0, 28) || locator.elementTag}`,
      detail: 'DOCX 选区',
      path: locator.path,
      refText
    })
    requestComposerFocus('main')
  })
  annotate.addEventListener('click', () => {
    if (!current) return
    const locator = { type: 'preview-document-element', format: 'docx', path: target.path || target.source, selectionType: current.selectionType, elementTag: current.element.tagName.toLowerCase(), elementIndex: current.elementIndex, text: current.text }
    requestPreviewAnnotation({ label: `${target.label} · ${current.selectionType === 'image' ? `图片 ${current.elementIndex + 1}` : current.text.slice(0, 28) || locator.elementTag}`, locator, onSaved: clearSelection, path: locator.path })
  })

  return () => {
    host.removeEventListener('mouseup', onMouseUp)
    host.removeEventListener('click', onClick)
  }
}

function renderSanitizedPptxSvg(host: HTMLElement, rawSvg: string) {
  const foreignObjectBodies: string[] = []
  const svgShell = rawSvg.replace(
    /<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi,
    (_whole, attributes: string, body: string) => {
      const index = foreignObjectBodies.push(body) - 1

      return `<foreignObject${attributes} data-pptx-foreign-object="${index}"></foreignObject>`
    }
  )

  host.innerHTML = DOMPurify.sanitize(svgShell, {
    ADD_ATTR: ['data-pptx-foreign-object', 'xmlns'],
    ADD_TAGS: ['foreignObject'],
    USE_PROFILES: { svg: true, svgFilters: true }
  })
  host.querySelectorAll<SVGForeignObjectElement>('foreignObject[data-pptx-foreign-object]').forEach(element => {
    const index = Number(element.dataset.pptxForeignObject)
    element.innerHTML = DOMPurify.sanitize(foreignObjectBodies[index] || '', {
      ADD_ATTR: ['xmlns'],
      USE_PROFILES: { html: true }
    })
    element.removeAttribute('data-pptx-foreign-object')
  })

  host.querySelectorAll<SVGGElement>('svg > g').forEach(group => {
    if (group.hasAttribute('data-pptx-shape-name') || group.hasAttribute('data-pptx-fallback')) return

    const cells = [...group.querySelectorAll<SVGForeignObjectElement>(':scope > foreignObject')]

    if (cells.length < 2 || group.querySelectorAll(':scope > rect').length < cells.length) return

    group.dataset.pptxTable = 'true'
    cells.forEach((cell, index) => {
      cell.dataset.pptxCell = String(index + 1)
    })
  })
}

function installPptxSelection(host: HTMLElement, target: PreviewTarget): () => void {
  host.classList.add('office-presentation-workspace')
  const toolbar = document.createElement('div')
  toolbar.className = 'office-presentation-selection-toolbar'
  toolbar.hidden = true
  const label = document.createElement('span')
  const cite = document.createElement('button')
  cite.type = 'button'
  cite.textContent = '引用并追问'
  const annotate = document.createElement('button')
  annotate.type = 'button'
  annotate.textContent = '添加批注'
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = '取消'
  const outline = document.createElement('div')
  outline.className = 'office-presentation-selection-outline'
  outline.hidden = true
  toolbar.append(label, cite, annotate, clear)
  host.append(outline, toolbar)

  type PptxSelection = {
    element: SVGGraphicsElement
    shapeIndex: number
    shapeName: string
    slide: number
    selectionType: 'cell' | 'image' | 'shape' | 'table' | 'text'
    text: string
  }
  let current: PptxSelection | null = null
  const shapeSelector = '[data-pptx-cell], [data-pptx-shape-name], [data-pptx-fallback], [data-pptx-table]'
  const shapeFromNode = (node: Node | null): SVGGraphicsElement | null => {
    let candidate: Node | null = node

    while (candidate && candidate !== host) {
      if (candidate instanceof Element && candidate.matches(shapeSelector)) return candidate as SVGGraphicsElement

      candidate = candidate.parentNode
    }

    return null
  }
  const clearSelection = () => {
    host.querySelectorAll('[data-pptx-selected]').forEach(element => element.removeAttribute('data-pptx-selected'))
    current = null
    outline.hidden = true
    toolbar.hidden = true
  }
  const selectShape = (element: SVGGraphicsElement, selectionType: PptxSelection['selectionType'], text: string) => {
    host.querySelectorAll('[data-pptx-selected]').forEach(candidate => candidate.removeAttribute('data-pptx-selected'))
    element.dataset.pptxSelected = 'true'
    const slideElement = element.closest<HTMLElement>('.office-pptx-slide')
    const slides = [...host.querySelectorAll<HTMLElement>('.office-pptx-slide')]
    const shapes = [...(slideElement?.querySelectorAll<SVGGraphicsElement>(shapeSelector) || [])]
    const shapeIndex = Math.max(0, shapes.indexOf(element))
    const shapeName = element.dataset.pptxCell
      ? `单元格 ${element.dataset.pptxCell}`
      : element.dataset.pptxTable
        ? '表格'
        : element.dataset.pptxShapeName || element.getAttribute('data-pptx-fallback') || `元素 ${shapeIndex + 1}`
    current = {
      element,
      shapeIndex,
      shapeName,
      slide: Math.max(1, slides.indexOf(slideElement!) + 1),
      selectionType,
      text: text.trim()
    }
    const elementRect = element.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    Object.assign(outline.style, {
      height: `${elementRect.height}px`,
      left: `${elementRect.left - hostRect.left}px`,
      top: `${elementRect.top - hostRect.top}px`,
      width: `${elementRect.width}px`
    })
    label.textContent = `第 ${current.slide} 页 · ${selectionType === 'text' ? current.text.slice(0, 28) : shapeName}`
    outline.hidden = false
    toolbar.hidden = false
  }
  const onMouseUp = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim() || ''
    const anchor = selection?.anchorNode

    if (!text || !anchor || !host.contains(anchor)) return

    const shape = shapeFromNode(anchor)

    if (shape && host.contains(shape)) selectShape(shape, 'text', text)
  }
  const onClick = (event: MouseEvent) => {
    const targetElement = event.target as Element

    if (targetElement.closest('.office-presentation-selection-toolbar')) return

    const shape = shapeFromNode(targetElement)

    if (!shape || !host.contains(shape)) return

    const selectionType = shape.hasAttribute('data-pptx-cell')
      ? 'cell'
      : shape.hasAttribute('data-pptx-table')
        ? 'table'
        : targetElement.closest('image')
          ? 'image'
          : 'shape'
    selectShape(shape, selectionType, shape.textContent || '')
  }

  host.addEventListener('mouseup', onMouseUp)
  host.addEventListener('click', onClick)
  clear.addEventListener('click', () => {
    window.getSelection()?.removeAllRanges()
    clearSelection()
  })
  cite.addEventListener('click', () => {
    if (!current) return

    const locator = {
      type: 'preview-presentation-element',
      format: 'pptx',
      path: target.path || target.source,
      slide: current.slide,
      selectionType: current.selectionType,
      shapeName: current.shapeName,
      shapeIndex: current.shapeIndex,
      text: current.text
    }
    const refText = `\n\n<preview_selection>\n${JSON.stringify(locator, null, 2)}\n</preview_selection>`

    mainComposerScope.add({
      id: `presentation:${locator.path}:${locator.slide}:${locator.shapeIndex}:${locator.selectionType}`,
      kind: 'selection',
      label: `${target.label} · 第 ${locator.slide} 页 · ${locator.shapeName}`,
      detail: 'PPTX 选区',
      path: locator.path,
      refText
    })
    requestComposerFocus('main')
  })
  annotate.addEventListener('click', () => {
    if (!current) return
    const locator = { type: 'preview-presentation-element', format: 'pptx', path: target.path || target.source, slide: current.slide, selectionType: current.selectionType, shapeName: current.shapeName, shapeIndex: current.shapeIndex, text: current.text }
    requestPreviewAnnotation({ label: `${target.label} · 第 ${locator.slide} 页 · ${locator.shapeName}`, locator, onSaved: clearSelection, path: locator.path })
  })

  return () => {
    host.removeEventListener('mouseup', onMouseUp)
    host.removeEventListener('click', onClick)
  }
}

async function renderXlsx(bytes: ArrayBuffer, host: HTMLElement, target: PreviewTarget) {
  const spreadsheetFormat = extension(target).slice(1) || 'xlsx'
  const { default: JSZip } = await import('jszip')
  const archive = await JSZip.loadAsync(bytes)
  const text = async (name: string) => archive.file(name)?.async('text')
  const workbookXml = await text('xl/workbook.xml')
  const relationshipsXml = await text('xl/_rels/workbook.xml.rels')

  if (!workbookXml || !relationshipsXml) {
    throw new Error('工作簿结构无效')
  }

  const workbook = parseXml(workbookXml)
  const relationships = parseXml(relationshipsXml)
  const targets = new Map(
    [...relationships.getElementsByTagName('Relationship')].map(node => [
      node.getAttribute('Id') || '',
      node.getAttribute('Target') || ''
    ])
  )
  const sharedXml = await text('xl/sharedStrings.xml')
  const cellStyles = parseCellStyles(await text('xl/styles.xml'))
  const shared = sharedXml
    ? [...parseXml(sharedXml).getElementsByTagName('si')].map(node => node.textContent || '')
    : []
  const sheets = [...workbook.getElementsByTagName('sheet')].map(node => ({
    name: node.getAttribute('name') || '工作表',
    target: targets.get(node.getAttribute('r:id') || '') || ''
  }))
  const tabs = document.createElement('div')
  tabs.className = 'office-sheet-tabs'
  const tabList = document.createElement('div')
  tabList.className = 'office-sheet-tab-list'
  const body = document.createElement('div')
  body.className = 'office-sheet-body'
  host.classList.add('office-sheet-workspace')
  let activeSheetIndex = 0

  const show = async (sheet: (typeof sheets)[number]) => {
    const rawPath = sheet.target.replace(/^\/?xl\//, '').replace(/^\.\.\//, '')
    const sheetXml = await text(`xl/${rawPath}`)

    if (!sheetXml) {
      throw new Error(`无法读取工作表：${sheet.name}`)
    }

    const xmlRows = [...parseXml(sheetXml).getElementsByTagName('row')].slice(0, 2000)
    const values = new Map<string, { style: number; value: string }>()
    const rowHeights = new Map<number, number>()
    let maxRow = 0
    let maxColumn = 0

    for (const row of xmlRows) {
      const rowIndex = Math.max(0, Number(row.getAttribute('r') || 1) - 1)
      const rowHeight = Number(row.getAttribute('ht'))

      if (rowHeight > 0) rowHeights.set(rowIndex, rowHeight * (4 / 3))
      maxRow = Math.max(maxRow, rowIndex)

      for (const cell of [...row.getElementsByTagName('c')].slice(0, 200)) {
        const column = columnIndex(cell.getAttribute('r') || 'A1')
        const type = cell.getAttribute('t')
        const raw = cell.getElementsByTagName('v')[0]?.textContent || ''
        const value = type === 's' ? (shared[Number(raw)] ?? '') : type === 'inlineStr' ? cell.textContent || '' : raw
        maxColumn = Math.max(maxColumn, column)
        values.set(`${rowIndex}:${column}`, { style: Number(cell.getAttribute('s') || 0), value })
      }
    }

    const parsedSheet = parseXml(sheetXml)
    const mergedStarts = new Map<string, { columns: number; rows: number }>()
    const mergedCovered = new Set<string>()

    for (const merge of [...parsedSheet.getElementsByTagName('mergeCell')]) {
      const [startText, endText] = (merge.getAttribute('ref') || '').split(':')

      if (!startText || !endText) continue

      const start = cellReference(startText)
      const end = cellReference(endText)
      mergedStarts.set(`${start.row}:${start.column}`, {
        columns: end.column - start.column + 1,
        rows: end.row - start.row + 1
      })
      maxRow = Math.max(maxRow, end.row)
      maxColumn = Math.max(maxColumn, end.column)

      for (let row = start.row; row <= end.row; row += 1) {
        for (let column = start.column; column <= end.column; column += 1) {
          if (row !== start.row || column !== start.column) mergedCovered.add(`${row}:${column}`)
        }
      }
    }

    maxRow = Math.min(maxRow, 1999)
    maxColumn = Math.min(maxColumn, 199)
    const table = document.createElement('table')
    table.style.tableLayout = 'fixed'
    const columns = document.createElement('colgroup')
    const cornerColumn = document.createElement('col')
    cornerColumn.style.width = '3rem'
    columns.appendChild(cornerColumn)
    const columnWidths = new Map<number, number>()

    for (const definition of [...parsedSheet.getElementsByTagName('col')]) {
      const first = Number(definition.getAttribute('min') || 1) - 1
      const last = Number(definition.getAttribute('max') || first + 1) - 1
      const width = Number(definition.getAttribute('width'))

      if (!(width > 0)) continue

      for (let column = first; column <= Math.min(last, maxColumn); column += 1) {
        columnWidths.set(column, Math.max(24, Math.round(width * 7 + 5)))
      }
    }

    for (let column = 0; column <= maxColumn; column += 1) {
      const col = document.createElement('col')
      col.style.width = `${columnWidths.get(column) || 80}px`
      columns.appendChild(col)
    }
    table.style.width = `${48 + Array.from({ length: maxColumn + 1 }, (_, column) => columnWidths.get(column) || 80).reduce((sum, width) => sum + width, 0)}px`
    table.appendChild(columns)
    const header = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'office-sheet-corner'
    header.appendChild(corner)

    type Selection = { c1: number; c2: number; r1: number; r2: number; type: 'cell' | 'column' | 'row' }
    let anchor: Selection | null = null
    let selection: Selection | null = null
    let draggingCells = false
    const formulaBar = document.createElement('div')
    formulaBar.className = 'office-sheet-formula-bar'
    const nameBox = document.createElement('div')
    nameBox.className = 'office-sheet-name-box'
    nameBox.textContent = 'A1'
    const formulaMark = document.createElement('span')
    formulaMark.className = 'office-sheet-formula-mark'
    formulaMark.textContent = 'fx'
    const formulaValue = document.createElement('div')
    formulaValue.className = 'office-sheet-formula-value'
    formulaValue.setAttribute('role', 'textbox')
    formulaValue.setAttribute('aria-readonly', 'true')
    formulaBar.append(nameBox, formulaMark, formulaValue)
    const outline = document.createElement('div')
    outline.className = 'office-sheet-selection-outline'
    outline.hidden = true
    const toolbar = document.createElement('div')
    toolbar.className = 'office-sheet-selection-toolbar'
    toolbar.hidden = true
    const rangeLabel = document.createElement('span')
    const cite = document.createElement('button')
    cite.type = 'button'
    cite.className = 'office-sheet-selection-primary'
    cite.textContent = '引用并追问'
    const annotate = document.createElement('button')
    annotate.type = 'button'
    annotate.className = 'office-sheet-selection-secondary'
    annotate.textContent = '添加批注'
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'office-sheet-selection-secondary'
    clear.textContent = '取消'
    toolbar.append(rangeLabel, cite, annotate, clear)

    const rangeText = (value: Selection) => {
      if (value.type === 'row') return `${value.r1 + 1}:${value.r2 + 1}`
      if (value.type === 'column') return `${columnName(value.c1)}:${columnName(value.c2)}`
      if (value.r1 === value.r2 && value.c1 === value.c2) return `${columnName(value.c1)}${value.r1 + 1}`

      return `${columnName(value.c1)}${value.r1 + 1}:${columnName(value.c2)}${value.r2 + 1}`
    }
    const paint = () => {
      table.querySelectorAll('[data-selected]').forEach(node => node.removeAttribute('data-selected'))

      if (!selection) {
        toolbar.hidden = true
        outline.hidden = true
        nameBox.textContent = ''
        formulaValue.textContent = ''

        return
      }

      table.querySelectorAll<HTMLElement>('[data-row][data-column]').forEach(cell => {
        const row = Number(cell.dataset.row)
        const column = Number(cell.dataset.column)
        const selectedCell =
          row >= selection!.r1 && row <= selection!.r2 && column >= selection!.c1 && column <= selection!.c2
        const selectedRowHeader = selection!.type === 'row' && column === -1 && row >= selection!.r1 && row <= selection!.r2
        const selectedColumnHeader =
          selection!.type === 'column' && row === -1 && column >= selection!.c1 && column <= selection!.c2

        if (selectedCell || selectedRowHeader || selectedColumnHeader) {
          cell.dataset.selected = 'true'
        }
      })
      rangeLabel.textContent = `${sheet.name} · ${rangeText(selection)}`
      nameBox.textContent = rangeText(selection)
      formulaValue.textContent =
        selection.type === 'cell' && selection.r1 === selection.r2 && selection.c1 === selection.c2
          ? values.get(`${selection.r1}:${selection.c1}`)?.value || ''
          : ''
      const selectedDataCells = [...table.querySelectorAll<HTMLElement>('td[data-selected]')]

      if (selectedDataCells.length) {
        const bodyRect = body.getBoundingClientRect()
        let rectangles = selectedDataCells.map(cell => cell.getBoundingClientRect())

        if (selection.type === 'row') {
          const rowHeaders = [...table.querySelectorAll<HTMLElement>('.office-sheet-row-header[data-selected]')]
          rectangles = [
            ...rowHeaders.map(headerCell => {
              const rectangle = headerCell.getBoundingClientRect()

              return new DOMRect(
                bodyRect.left + headerCell.offsetWidth,
                rectangle.top,
                body.clientWidth - headerCell.offsetWidth,
                rectangle.height
              )
            })
          ]
        } else if (selection.type === 'column') {
          const columnHeaders = [...table.querySelectorAll<HTMLElement>('.office-sheet-column-header[data-selected]')]
          const firstRow = table.querySelector<HTMLElement>('.office-sheet-row-header')?.getBoundingClientRect()
          rectangles = columnHeaders.map(headerCell => {
            const rectangle = headerCell.getBoundingClientRect()

            return new DOMRect(
              rectangle.left,
              firstRow?.top || rectangle.bottom,
              rectangle.width,
              body.clientHeight - (firstRow?.top || rectangle.bottom) + bodyRect.top
            )
          })
        }
        const left = Math.min(...rectangles.map(rectangle => rectangle.left)) - bodyRect.left + body.scrollLeft
        const top = Math.min(...rectangles.map(rectangle => rectangle.top)) - bodyRect.top + body.scrollTop
        const right = Math.max(...rectangles.map(rectangle => rectangle.right)) - bodyRect.left + body.scrollLeft
        const bottom = Math.max(...rectangles.map(rectangle => rectangle.bottom)) - bodyRect.top + body.scrollTop
        Object.assign(outline.style, {
          height: `${bottom - top}px`,
          left: `${left}px`,
          top: `${top}px`,
          width: `${right - left}px`
        })
        outline.hidden = false
      }
      toolbar.hidden = false
    }
    const select = (next: Selection, extend: boolean) => {
      if (!extend || !anchor || anchor.type !== next.type) {
        anchor = next
        selection = next
      } else {
        selection = {
          type: next.type,
          r1: Math.min(anchor.r1, next.r1),
          r2: Math.max(anchor.r2, next.r2),
          c1: Math.min(anchor.c1, next.c1),
          c2: Math.max(anchor.c2, next.c2)
        }
      }
      paint()
    }
    body.addEventListener('scroll', () => {
      if (selection?.type === 'row' || selection?.type === 'column') paint()
    })

    for (let column = 0; column <= maxColumn; column += 1) {
      const th = document.createElement('th')
      th.className = 'office-sheet-column-header'
      th.textContent = columnName(column)
      th.dataset.row = '-1'
      th.dataset.column = String(column)
      th.addEventListener('click', event =>
        select({ c1: column, c2: column, r1: 0, r2: maxRow, type: 'column' }, event.shiftKey)
      )
      header.appendChild(th)
    }
    table.appendChild(header)

    for (let row = 0; row <= maxRow; row += 1) {
      const tr = document.createElement('tr')
      const rowHeight = rowHeights.get(row)

      if (rowHeight) tr.style.height = `${rowHeight}px`
      const rowHeader = document.createElement('th')
      rowHeader.className = 'office-sheet-row-header'
      rowHeader.textContent = String(row + 1)
      rowHeader.dataset.row = String(row)
      rowHeader.dataset.column = '-1'
      rowHeader.addEventListener('click', event =>
        select({ c1: 0, c2: maxColumn, r1: row, r2: row, type: 'row' }, event.shiftKey)
      )
      tr.appendChild(rowHeader)

      for (let column = 0; column <= maxColumn; column += 1) {
        if (mergedCovered.has(`${row}:${column}`)) continue

        const td = document.createElement('td')
        const data = values.get(`${row}:${column}`)
        const merge = mergedStarts.get(`${row}:${column}`)
        td.dataset.row = String(row)
        td.dataset.column = String(column)
        td.textContent = data?.value || ''

        if (merge) {
          td.colSpan = merge.columns
          td.rowSpan = merge.rows
        }
        applyCellStyle(td, cellStyles[data?.style || 0])
        const cellSelection = (): Selection => ({ c1: column, c2: column, r1: row, r2: row, type: 'cell' })
        td.addEventListener('pointerdown', event => {
          if (event.button !== 0) return

          event.preventDefault()
          draggingCells = true
          select(cellSelection(), event.shiftKey)
          window.addEventListener(
            'pointerup',
            () => {
              draggingCells = false
            },
            { once: true }
          )
        })
        td.addEventListener('pointerenter', event => {
          if (draggingCells && (event.buttons & 1) === 1) select(cellSelection(), true)
        })
        tr.appendChild(td)
      }
      table.appendChild(tr)
    }

    cite.addEventListener('click', () => {
      if (!selection) return
      const range = rangeText(selection)
      const selectedValues = []
      const totalCells = (selection.r2 - selection.r1 + 1) * (selection.c2 - selection.c1 + 1)
      const maxReferencedCells = 5000
      let referencedCells = 0

      for (let row = selection.r1; row <= selection.r2; row += 1) {
        const rowValues = []

        for (let column = selection.c1; column <= selection.c2 && referencedCells < maxReferencedCells; column += 1) {
          rowValues.push(values.get(`${row}:${column}`)?.value || '')
          referencedCells += 1
        }
        selectedValues.push(rowValues)

        if (referencedCells >= maxReferencedCells) break
      }
      const locator = {
        type: 'preview-spreadsheet-range',
        format: spreadsheetFormat,
        path: target.path || target.source,
        sheet: sheet.name,
        range,
        selectionType: selection.type,
        totalCells,
        truncated: totalCells > maxReferencedCells,
        values: selectedValues
      }
      const refText = `\n\n<preview_selection>\n${JSON.stringify(locator, null, 2)}\n</preview_selection>`

      mainComposerScope.add({
        id: `spreadsheet:${locator.path}:${sheet.name}:${range}`,
        kind: 'selection',
        label: `${target.label} · ${sheet.name} · ${range}`,
        detail: `${spreadsheetFormat.toUpperCase()} 选区`,
        path: locator.path,
        refText
      })
      requestComposerFocus('main')
    })
    annotate.addEventListener('click', () => {
      if (!selection) return
      const range = rangeText(selection)
      const selectedValues: string[][] = []
      const maxReferencedCells = 5000
      let referencedCells = 0
      for (let row = selection.r1; row <= selection.r2; row += 1) {
        const rowValues: string[] = []
        for (let column = selection.c1; column <= selection.c2 && referencedCells < maxReferencedCells; column += 1) {
          rowValues.push(values.get(`${row}:${column}`)?.value || '')
          referencedCells += 1
        }
        selectedValues.push(rowValues)
        if (referencedCells >= maxReferencedCells) break
      }
      const totalCells = (selection.r2 - selection.r1 + 1) * (selection.c2 - selection.c1 + 1)
      const locator = { type: 'preview-spreadsheet-range', format: spreadsheetFormat, path: target.path || target.source, sheet: sheet.name, range, selectionType: selection.type, totalCells, truncated: totalCells > maxReferencedCells, values: selectedValues }
      requestPreviewAnnotation({
        label: `${target.label} · ${sheet.name} · ${range}`,
        locator,
        onSaved: () => {
          anchor = null
          selection = null
          paint()
        },
        path: locator.path
      })
    })
    clear.addEventListener('click', () => {
      anchor = null
      selection = null
      paint()
    })

    body.replaceChildren(table, outline)
    activeSheetIndex = Math.max(0, sheets.indexOf(sheet))
    host.replaceChildren(formulaBar, body, toolbar, tabs)
    tabs.querySelectorAll('button').forEach(button => button.toggleAttribute('data-active', button.textContent === sheet.name))
  }

  const previousSheet = document.createElement('button')
  previousSheet.type = 'button'
  previousSheet.className = 'office-sheet-navigation'
  previousSheet.setAttribute('aria-label', '上一个工作表')
  previousSheet.textContent = '‹'
  previousSheet.addEventListener('click', () => void show(sheets[Math.max(0, activeSheetIndex - 1)]))
  const nextSheet = document.createElement('button')
  nextSheet.type = 'button'
  nextSheet.className = 'office-sheet-navigation'
  nextSheet.setAttribute('aria-label', '下一个工作表')
  nextSheet.textContent = '›'
  nextSheet.addEventListener('click', () => void show(sheets[Math.min(sheets.length - 1, activeSheetIndex + 1)]))
  tabs.append(previousSheet, nextSheet, tabList)

  for (const sheet of sheets) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'office-sheet-tab'
    button.textContent = sheet.name
    button.addEventListener('click', () => void show(sheet))
    tabList.appendChild(button)
  }
  host.replaceChildren(body, tabs)

  if (sheets[0]) {
    await show(sheets[0])
  }
}

export function OfficeFilePreview({ target }: { target: PreviewTarget }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const spreadsheet = ['.xlsm', '.xlsx'].includes(extension(target))

  useEffect(() => {
    let active = true
    let cleanupSelection: (() => void) | undefined
    const host = hostRef.current

    if (!host) {
      return
    }

    host.replaceChildren()
    setError(null)

    void (async () => {
      const ext = extension(target)
      const bytes = dataUrlBytes(target.dataUrl || (await readDesktopFileDataUrl(target.path || target.source)))

      if (!active) {
        return
      }

      if (ext === '.docx') {
        const { renderAsync } = await import('docx-preview')
        await renderAsync(bytes, host, host, {
          breakPages: true,
          ignoreFonts: false,
          inWrapper: true,
          renderFootnotes: true,
          renderHeaders: true
        })
        cleanupSelection = installDocxSelection(host, target)

        return
      }

      if (ext === '.pptx') {
        const [{ getSlides, loadPresentation }, { renderSlideToSvg }] = await Promise.all([
          import('@office-kit/pptx'),
          import('@office-kit/pptx-preview')
        ])
        const presentation = await loadPresentation(bytes)

        for (const [index, slide] of getSlides(presentation).entries()) {
          const page = document.createElement('section')
          page.className = 'office-pptx-slide'
          page.dataset.slide = String(index + 1)
          renderSanitizedPptxSvg(page, renderSlideToSvg(presentation, slide))
          host.appendChild(page)
        }
        cleanupSelection = installPptxSelection(host, target)

        return
      }

      if (ext === '.xlsx' || ext === '.xlsm') {
        await renderXlsx(bytes, host, target)

        return
      }

      throw new Error(`The bundled renderer does not yet support ${ext || 'this Office format'}`)
    })().catch(reason => {
      if (active) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })

    return () => {
      active = false
      cleanupSelection?.()
      host.replaceChildren()
    }
  }, [target.dataUrl, target.path, target.source])

  if (error) {
    return <PreviewEmptyState body={error} title="Office 预览不可用" />
  }

  return (
    <div
      className={`office-preview h-full bg-(--ui-bg-canvas) ${spreadsheet ? 'overflow-hidden' : 'overflow-auto p-4'}`}
    >
      <div className={spreadsheet ? 'h-full min-h-0' : 'mx-auto min-h-full'} ref={hostRef} />
    </div>
  )
}
