import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { BrandFilter, CountryFilter, TimezoneKey } from './types'
import {
  appendMessage, createConversation, deleteConversation, loadHistory, saveHistory, updateConversation,
  type AssistantHistory, type AssistantMessage,
} from './assistantHistory'
import { buildAssistantPresentation } from './assistantPresentation'
import styles from './ChatAssistant.module.css'

type Message = AssistantMessage

interface ChatAssistantProps {
  filters: {
    brand: BrandFilter
    country: CountryFilter
    timezone: TimezoneKey
    start: number
    end: number
  }
}

const suggestions = [
  'Summarize orders versus the previous period',
  'Show revenue by currency',
  'How are payment gateways performing?',
  'Are there any traffic or latency concerns?',
]

const welcomeMessage: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    'Hi, I can help you make sense of orders, revenue, payments, traffic, and system health. What would you like to know?',
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function scopeRows(message: Message): string[][] {
  const scope = message.scope
  if (!scope) return []
  const zone = { Dubai: 'Asia/Dubai', UTC: 'UTC', IST: 'Asia/Kolkata' }[scope.tz] || 'UTC'
  const date = (value: number | null) => value === null
    ? 'Not specified'
    : `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(value))} (${scope.tz})`
  return [
    ['Brand', scope.brand === 'all' ? 'All brands' : scope.brand],
    ['Country', scope.country === 'all' ? 'All countries' : { AE: 'United Arab Emirates', SA: 'Saudi Arabia', EG: 'Egypt', QA: 'Qatar', KW: 'Kuwait' }[scope.country] || scope.country],
    ['Timezone', scope.tz],
    ['Window start', date(scope.start)],
    ['Window end', date(scope.end)],
  ]
}

async function exportPdf(message: Message) {
  const presentation = buildAssistantPresentation(message)
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  doc.setFillColor(15, 76, 51)
  doc.rect(0, 0, pageWidth, 92, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('MAGRABi Commerce Assist', 44, 42)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text('Grounded operational answer · Read-only platform data', 44, 62)

  autoTable(doc, {
    startY: 112,
    head: [['Question', 'Answer']],
    body: [[message.question || 'Platform data question', message.content]],
    theme: 'grid',
    headStyles: { fillColor: [15, 76, 51], textColor: 255 },
    styles: { fontSize: 10, cellPadding: 10, overflow: 'linebreak' },
    columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: pageWidth - 248 } },
    margin: { left: 44, right: 44, bottom: 48 },
  })
  const answerEnd = (doc as typeof doc & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 150
  let sectionEnd = answerEnd
  if (presentation) {
    let headingY = sectionEnd + 25
    if (headingY > 740) { doc.addPage(); headingY = 52 }
    doc.setTextColor(26, 68, 43)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.text(presentation.title, 44, headingY)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100, 116, 105)
    doc.setFontSize(8.5)
    doc.text(presentation.subtitle, 44, headingY + 15)
    autoTable(doc, {
      startY: headingY + 27,
      head: [['Metric', 'Value', 'Source']],
      body: presentation.rows.map((row) => [row.metric, row.value, row.source]),
      theme: 'grid',
      headStyles: { fillColor: [15, 76, 51], textColor: 255 },
      alternateRowStyles: { fillColor: [246, 250, 247] },
      styles: { fontSize: 9, cellPadding: 8, overflow: 'linebreak' },
      columnStyles: { 0: { cellWidth: 210 }, 1: { cellWidth: 125, fontStyle: 'bold' }, 2: { cellWidth: 172 } },
      margin: { left: 44, right: 44, bottom: 48 },
    })
    sectionEnd = (doc as typeof doc & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || headingY + 70
    const noteLines = doc.splitTextToSize(presentation.note, pageWidth - 88)
    if (sectionEnd + 11 + noteLines.length * 11 > 780) { doc.addPage(); sectionEnd = 45 }
    doc.setFontSize(8.5)
    doc.setTextColor(90, 106, 96)
    doc.text(noteLines, 44, sectionEnd + 13)
    sectionEnd += 17 + noteLines.length * 11
  }
  autoTable(doc, {
    startY: sectionEnd + 18,
    head: [['Selected scope', 'Value']],
    body: scopeRows(message),
    theme: 'grid',
    headStyles: { fillColor: [15, 76, 51], textColor: 255 },
    styles: { fontSize: 8.5, cellPadding: 6 },
  })
  const tableEnd = (doc as typeof doc & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || answerEnd
  autoTable(doc, {
    startY: tableEnd + 18,
    head: [['Source', 'Evidence used', 'Status']],
    body: (message.evidence || []).map((source) => [
      source.name,
      [source.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n'), source.note].filter(Boolean).join('\n'),
      `${source.status}\n${new Date(source.updatedAt).toLocaleString('en-GB')}`,
    ]),
    theme: 'striped',
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    styles: { fontSize: 8.5, cellPadding: 6 },
  })

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    doc.setFontSize(8)
    doc.setTextColor(100, 116, 139)
    doc.text(`Generated ${new Date(message.generatedAt || Date.now()).toLocaleString('en-GB')} · Page ${page} of ${pages}`, 44, 810)
  }
  doc.save(`Magrabi_Commerce_Assist_${stamp()}.pdf`)
}

function flatten(value: unknown, prefix = '', rows: Array<[string, string]> = []) {
  if (value === null || value === undefined) {
    rows.push([prefix, ''])
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, rows))
  } else if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) =>
      flatten(item, prefix ? `${prefix}.${key}` : key, rows),
    )
  } else {
    rows.push([prefix, String(value)])
  }
  return rows
}

async function exportExcel(message: Message) {
  const presentation = buildAssistantPresentation(message)
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Magrabi Commerce Assist'
  workbook.created = new Date()
  const answerSheet = workbook.addWorksheet('Assistant answer', { views: [{ showGridLines: false }] })
  answerSheet.columns = [{ width: 24 }, { width: 86 }]
  answerSheet.mergeCells('A1:B1')
  answerSheet.getCell('A1').value = 'MAGRABi COMMERCE ASSIST'
  answerSheet.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 16 }
  answerSheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C33' } }
  answerSheet.getCell('A1').alignment = { vertical: 'middle' }
  answerSheet.getRow(1).height = 34

  const rows: Array<[string, string]> = [
    ['Question', message.question || 'Platform data question'],
    ['Answer', message.content],
    ['Generated', new Date(message.generatedAt || Date.now()).toLocaleString('en-GB')],
    ...scopeRows(message).map((row) => [row[0], row[1]] as [string, string]),
  ]
  rows.forEach(([label, value], index) => {
    const row = answerSheet.addRow([label, value])
    row.getCell(1).font = { bold: true, color: { argb: 'FF0F5132' } }
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' }
    row.height = index === 1 ? Math.max(72, Math.ceil(value.length / 90) * 18) : 24
  })

  if (presentation) {
    answerSheet.addRow([])
    const figuresHeader = answerSheet.addRow(['KEY FIGURES', presentation.subtitle])
    figuresHeader.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C33' } }
    })
    presentation.highlights.forEach((figure) => {
      const row = answerSheet.addRow([figure.metric, `${figure.value}  (${figure.source})`])
      row.getCell(1).font = { bold: true, color: { argb: 'FF0F5132' } }
      row.height = 24
    })

    const tableSheet = workbook.addWorksheet('Data table', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] })
    tableSheet.columns = [{ width: 35 }, { width: 28 }, { width: 28 }]
    tableSheet.mergeCells('A1:C1')
    tableSheet.getCell('A1').value = presentation.title.toUpperCase()
    tableSheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }
    tableSheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C33' } }
    tableSheet.getRow(1).height = 35
    tableSheet.mergeCells('A2:C2')
    tableSheet.getCell('A2').value = presentation.subtitle
    tableSheet.getCell('A2').font = { color: { argb: 'FF607568' }, italic: true }
    const header = tableSheet.getRow(4)
    header.values = ['Metric', 'Value', 'Source']
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }
      cell.alignment = { vertical: 'middle' }
    })
    header.height = 25
    presentation.rows.forEach((item, index) => {
      const row = tableSheet.addRow([item.metric, item.value, item.source])
      row.height = 26
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'middle', wrapText: true }
        if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F8F4' } }
      })
      row.getCell(2).font = { bold: true, color: { argb: 'FF0F5132' } }
    })
    tableSheet.autoFilter = `A4:C${4 + presentation.rows.length}`
    tableSheet.mergeCells(`A${5 + presentation.rows.length}:C${5 + presentation.rows.length}`)
    tableSheet.getCell(`A${5 + presentation.rows.length}`).value = presentation.note
    tableSheet.getCell(`A${5 + presentation.rows.length}`).alignment = { wrapText: true, vertical: 'middle' }
    tableSheet.getRow(5 + presentation.rows.length).height = 42
  }

  answerSheet.addRow([])
  const sourceHeader = answerSheet.addRow(['Source', 'Feed / updated'])
  sourceHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }
  })
  ;(message.sources || []).forEach((source) =>
    answerSheet.addRow([
      source.name,
      `${source.status} · ${new Date(source.updatedAt).toLocaleString('en-GB')}`,
    ]),
  )

  answerSheet.addRow([])
  ;(message.evidence || []).forEach((source) => {
    answerSheet.addRow([source.name, source.note])
    source.facts.forEach((fact) => answerSheet.addRow([fact.label, fact.value]))
  })

  const dataSheet = workbook.addWorksheet('Grounding data')
  dataSheet.columns = [{ width: 54 }, { width: 60 }]
  const dataHeader = dataSheet.addRow(['Field', 'Value'])
  dataHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5132' } }
  })
  flatten(message.exportData || {}).forEach(([key, value]) => dataSheet.addRow([key, value]))
  dataSheet.autoFilter = 'A1:B1'

  const buffer = await workbook.xlsx.writeBuffer()
  downloadBlob(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Magrabi_Commerce_Assist_${stamp()}.xlsx`,
  )
}

async function exportWord(message: Message) {
  const presentation = buildAssistantPresentation(message)
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx')
  const tableRows = [
    new TableRow({
      children: ['Selected scope', 'Value'].map(
        (text) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF' })] })], shading: { fill: '0F4C33' } }),
      ),
    }),
    ...scopeRows(message).map(
      ([label, value]) =>
        new TableRow({
          children: [label, value].map((text) => new TableCell({ children: [new Paragraph(text)] })),
        }),
    ),
  ]

  const dataTable = presentation ? new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ['Metric', 'Value', 'Source'].map((text) => new TableCell({
        shading: { fill: '0F4C33' }, children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF' })] })],
      })) }),
      ...presentation.rows.map((item, index) => new TableRow({ children: [item.metric, item.value, item.source].map((text) => new TableCell({
        shading: { fill: index % 2 === 0 ? 'F3F8F4' : 'FFFFFF' }, children: [new Paragraph(text)],
      })) })),
    ],
  }) : null

  const doc = new Document({
    creator: 'Magrabi Commerce Assist',
    title: message.question || 'Commerce Assist answer',
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: 'MAGRABi Commerce Assist', heading: HeadingLevel.TITLE }),
          new Paragraph({ children: [new TextRun({ text: 'Grounded operational answer · Read-only platform data', color: '64748B' })] }),
          new Paragraph({ text: 'Question', heading: HeadingLevel.HEADING_1 }),
          new Paragraph(message.question || 'Platform data question'),
          ...(presentation && dataTable ? [
            new Paragraph({ text: presentation.title, heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun({ text: presentation.subtitle, color: '64748B' })] }),
            dataTable,
            new Paragraph({ children: [new TextRun({ text: presentation.note, italics: true, color: '64748B' })] }),
          ] : []),
          new Paragraph({ text: 'Answer', heading: HeadingLevel.HEADING_1 }),
          ...message.content.split('\n').map((line) => new Paragraph({ text: line || ' ' })),
          new Paragraph({ text: 'Selected scope', heading: HeadingLevel.HEADING_1 }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }),
          new Paragraph({ text: 'Sources', heading: HeadingLevel.HEADING_1 }),
          ...(message.sources || []).map(
            (source) =>
              new Paragraph({
                text: `${source.name} — ${source.status} · ${new Date(source.updatedAt).toLocaleString('en-GB')}`,
                bullet: { level: 0 },
              }),
          ),
          new Paragraph({ text: 'Evidence used', heading: HeadingLevel.HEADING_1 }),
          ...(message.evidence || []).flatMap((source) => [
            new Paragraph({ text: source.name, heading: HeadingLevel.HEADING_2 }),
            ...source.facts.map((fact) => new Paragraph({ text: `${fact.label}: ${fact.value}`, bullet: { level: 0 } })),
            new Paragraph(source.note),
          ]),
          new Paragraph({ children: [new TextRun({ text: `Generated ${new Date(message.generatedAt || Date.now()).toLocaleString('en-GB')}`, italics: true, color: '64748B' })] }),
        ],
      },
    ],
  })
  const blob = await Packer.toBlob(doc)
  downloadBlob(blob, `Magrabi_Commerce_Assist_${stamp()}.docx`)
}

function MessageContent({ content, answer = false }: { content: string; answer?: boolean }) {
  return (
    <div className={`${styles.messageText} ${answer ? styles.answerText : ''}`}>
      {content.split('\n').map((line, index) => (
        <p key={`${line}-${index}`} className={answer && index === 0 ? styles.answerLead : undefined}>{line || '\u00A0'}</p>
      ))}
    </div>
  )
}

function AnswerVisual({ message }: { message: Message }) {
  const presentation = buildAssistantPresentation(message)
  if (!presentation) return null
  return (
    <section className={styles.answerVisual} aria-label={presentation.title}>
      <div className={styles.visualHeading}>
        <strong>{presentation.title}</strong>
        <span>Query scope: {presentation.subtitle}</span>
        {message.generatedAt && <small>Data checked {new Date(message.generatedAt).toLocaleString('en-GB')}</small>}
        {message.understanding?.mode === 'gemini' && <small>Request interpreted with Gemini</small>}
      </div>
      {presentation.highlights.length > 0 && (
        <div className={styles.metricGrid}>
          {presentation.highlights.map((figure) => (
            <div className={styles.metricCard} key={`${figure.source}-${figure.metric}`}>
              <span>{figure.metric}</span>
              <strong>{figure.value}</strong>
              <small>{figure.source}</small>
            </div>
          ))}
        </div>
      )}
      <details className={styles.dataDisclosure}>
        <summary>View supporting data <span>{presentation.rows.length} metrics</span></summary>
        <div className={styles.dataTableWrap}>
          <table className={styles.dataTable}>
            <thead><tr><th scope="col">Metric / source</th><th scope="col">Value</th></tr></thead>
            <tbody>{presentation.rows.map((row, index) => (
              <tr key={`${row.source}-${row.metric}-${index}`}>
                <td><strong>{row.metric}</strong><small>{row.source}</small></td>
                <td>{row.value}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className={styles.visualNote}>{presentation.note}</p>
      </details>
    </section>
  )
}

function answerModeLabel(message: Message) {
  if (message.mode === 'gemini') return 'Gemini-assisted answer'
  if (message.ai?.status === 'service_unavailable') return 'Platform answer · Gemini temporarily unavailable'
  if (message.ai?.status === 'rate_limited') return 'Platform answer · Gemini rate limited'
  if (message.ai?.status === 'auth_failed') return 'Platform answer · Gemini access rejected'
  if (message.ai?.status === 'timeout' || message.ai?.status === 'network_error') return 'Platform answer · Gemini connection failed'
  if (message.ai?.status === 'output_limit' || message.ai?.status === 'no_answer') return 'Platform answer · Gemini returned no usable answer'
  if (message.ai?.status === 'ungrounded_output') return 'Verified platform answer · unsupported AI detail removed'
  return 'Verified platform answer'
}

export function ChatAssistant({ filters }: ChatAssistantProps) {
  const [open, setOpen] = useState(false)
  const [history, setHistory] = useState<AssistantHistory>(loadHistory)
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.visualViewport?.width || window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.visualViewport?.height || window.innerHeight : 768,
    left: typeof window !== 'undefined' ? window.visualViewport?.offsetLeft || 0 : 0,
    top: typeof window !== 'undefined' ? window.visualViewport?.offsetTop || 0 : 0,
  }))
  const [showHistory, setShowHistory] = useState(() => {
    if (typeof window === 'undefined') return false
    const initialWidth = window.visualViewport?.width || window.innerWidth
    const initialHeight = window.visualViewport?.height || window.innerHeight
    return initialWidth > 750 && !(initialWidth <= 900 && initialHeight <= 500)
  })
  const [historyQuery, setHistoryQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const activeThread = history.conversations.find((item) => item.id === history.activeId)
  const messages = activeThread?.messages.length ? activeThread.messages : [welcomeMessage]
  const visibleThreads = [...history.conversations]
    .filter((item) => item.title.toLowerCase().includes(historyQuery.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const compactViewport = viewport.width <= 750 || (viewport.width <= 900 && viewport.height <= 500)
  const virtualMobileViewport = viewport.width <= 750 && typeof window !== 'undefined' && window.innerWidth > 750
  const panelStyle: CSSProperties | undefined = virtualMobileViewport ? {
    left: viewport.left + 8, top: viewport.top + 8, right: 'auto', bottom: 'auto',
    width: Math.max(280, viewport.width - 16), height: Math.max(300, viewport.height - 16),
  } : undefined
  const launcherStyle: CSSProperties | undefined = virtualMobileViewport ? {
    left: viewport.left + viewport.width - 170, top: viewport.top + viewport.height - 63,
    right: 'auto', bottom: 'auto',
  } : undefined

  useEffect(() => {
    const syncViewport = () => setViewport({
      width: window.visualViewport?.width || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight,
      left: window.visualViewport?.offsetLeft || 0,
      top: window.visualViewport?.offsetTop || 0,
    })
    window.addEventListener('resize', syncViewport)
    window.visualViewport?.addEventListener('resize', syncViewport)
    window.visualViewport?.addEventListener('scroll', syncViewport)
    return () => {
      window.removeEventListener('resize', syncViewport)
      window.visualViewport?.removeEventListener('resize', syncViewport)
      window.visualViewport?.removeEventListener('scroll', syncViewport)
    }
  }, [])

  useEffect(() => {
    if (!saveHistory(history)) setNotice('Conversation history could not be saved in this browser.')
  }, [history])

  useEffect(() => {
    const syncHistory = (event: StorageEvent) => {
      if (event.key === 'magrabi-commerce-assist-history-v1' && !loading) setHistory(loadHistory())
    }
    window.addEventListener('storage', syncHistory)
    return () => window.removeEventListener('storage', syncHistory)
  }, [loading])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false)
    }
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'),
      ).filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', handleDialogKeys)
    inputRef.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', handleDialogKeys)
      window.requestAnimationFrame(() => launcherRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open || !compactViewport) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open, compactViewport])

  useEffect(() => {
    const latest = messages[messages.length - 1]
    if (latest?.role === 'assistant' && latest.question) {
      const leads = panelRef.current?.querySelectorAll<HTMLElement>(`.${styles.answerLead}`)
      leads?.[leads.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [history.activeId, history.conversations, loading])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const runExport = async (format: 'PDF' | 'Excel' | 'Word', message: Message) => {
    try {
      setNotice(`Preparing ${format}…`)
      if (format === 'PDF') await exportPdf(message)
      else if (format === 'Excel') await exportExcel(message)
      else await exportWord(message)
      setNotice(`${format} downloaded`)
    } catch {
      setNotice(`${format} download failed. Please try again.`)
    }
  }

  const copyAnswer = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setNotice('Answer copied')
    } catch {
      setNotice('Could not copy the answer')
    }
  }

  const newConversation = () => {
    if (loading) return
    const thread = createConversation(crypto.randomUUID())
    setHistory((current) => ({ activeId: thread.id, conversations: [thread, ...current.conversations] }))
    setInput('')
    setError('')
    setShowHistory((window.visualViewport?.width || window.innerWidth) > 750)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const selectConversation = (id: string) => {
    if (loading) return
    setHistory((current) => ({ ...current, activeId: id }))
    setShowHistory((window.visualViewport?.width || window.innerWidth) > 750)
    setError('')
    setInput('')
  }

  const saveTitle = (id: string) => {
    const title = editingTitle.trim().slice(0, 80)
    if (title) setHistory((current) => updateConversation(current, id, (item) => ({ ...item, title })))
    setEditingId(null)
  }

  const removeConversation = (id: string) => {
    if (loading || !window.confirm('Delete this saved conversation from this browser?')) return
    setHistory((current) => deleteConversation(current, id))
    setNotice('Conversation deleted')
  }

  const submit = async (question = input) => {
    const cleanQuestion = question.trim()
    if (!cleanQuestion || loading) return
    const threadId = history.activeId || crypto.randomUUID()
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: cleanQuestion }
    setHistory((current) => appendMessage(current, threadId, userMessage))
    setInput('')
    setError('')
    setLoading(true)

    try {
      const history = messages
        .filter((message) => message.id !== 'welcome')
        .slice(-8)
        .map(({ role, content }) => ({ role, content }))
      const response = await fetch('/api/commerce/assistant/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: cleanQuestion, history, filters }),
      })
      const payload = await response.json()
      if (!response.ok || payload.status !== 'OK') throw new Error(payload.error || 'Commerce Assist could not answer that question.')
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: payload.answer,
        question: cleanQuestion,
        sources: payload.sources,
        evidence: payload.evidence,
        scope: payload.scope,
        generatedAt: payload.generatedAt,
        exportData: payload.exportData,
        mode: payload.mode,
        ai: payload.ai,
        understanding: payload.understanding,
        intent: payload.intent,
        clarification: payload.clarification,
      }
      setHistory((current) => appendMessage(current, threadId, assistantMessage))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Commerce Assist is temporarily unavailable.')
      setHistory((current) => updateConversation(current, threadId, (item) => ({
        ...item,
        messages: item.messages.filter((message) => message.id !== userMessage.id),
      })))
      setInput(cleanQuestion)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button
        ref={launcherRef}
        className={styles.launcher}
        style={launcherStyle}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Commerce Assist"
      >
        <span className={styles.sparkIcon}>✦</span>
        <span>Commerce Assist</span>
      </button>
    )
  }

  return (
    <section ref={panelRef} className={`${styles.panel} ${compactViewport ? styles.compactPanel : ''}`} style={panelStyle} role="dialog" aria-modal={compactViewport || undefined} aria-label="Commerce Assist">
      <header className={styles.header}>
        <button className={styles.iconButton} type="button" onClick={() => setShowHistory((value) => !value)} aria-label="Toggle conversation history" aria-controls="commerce-assist-history" aria-expanded={showHistory} title="History">☰</button>
        <div className={styles.avatar}><span>✦</span></div>
        <div className={styles.headerCopy}>
          <strong>Commerce Assist</strong>
          <span><i /> Magrabi commerce intelligence</span>
        </div>
        <button className={styles.newChatHeader} type="button" onClick={newConversation} disabled={loading}>+ New chat</button>
        <button className={styles.iconButton} type="button" onClick={() => setOpen(false)} aria-label="Minimize Commerce Assist" title="Minimize">—</button>
      </header>
      <div className={styles.body}>
        <aside id="commerce-assist-history" className={`${styles.historyRail} ${showHistory ? styles.historyRailOpen : ''}`} aria-label="Conversation history" aria-hidden={!showHistory}>
          <div className={styles.railTitle}><span>YOUR CONVERSATIONS</span><span>{history.conversations.length}</span></div>
          <label className={styles.historySearch}>
            <span>⌕</span>
            <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Search history" aria-label="Search conversation history" />
          </label>
          <div className={styles.threadList}>
            {visibleThreads.length === 0 && <p className={styles.emptyHistory}>{historyQuery ? 'No matching conversations' : 'Your conversations will appear here.'}</p>}
            {visibleThreads.map((thread) => (
              <div key={thread.id} className={`${styles.threadItem} ${thread.id === history.activeId ? styles.threadActive : ''}`}>
                {editingId === thread.id ? (
                  <input
                    className={styles.editTitle}
                    value={editingTitle}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onBlur={() => saveTitle(thread.id)}
                    onKeyDown={(event) => { if (event.key === 'Enter') saveTitle(thread.id); if (event.key === 'Escape') setEditingId(null) }}
                    autoFocus
                    aria-label="Rename conversation"
                  />
                ) : (
                  <button type="button" className={styles.threadSelect} disabled={loading} onClick={() => selectConversation(thread.id)}>
                    <span className={styles.threadName}>{thread.title}</span>
                    <span className={styles.threadDate}>{new Date(thread.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {Math.floor(thread.messages.length / 2)} answers</span>
                  </button>
                )}
                <div className={styles.threadActions}>
                  <button type="button" disabled={loading} onClick={() => { setEditingId(thread.id); setEditingTitle(thread.title) }} aria-label={`Rename ${thread.title}`} title="Rename">✎</button>
                  <button type="button" disabled={loading} onClick={() => removeConversation(thread.id)} aria-label={`Delete ${thread.title}`} title="Delete">×</button>
                </div>
              </div>
            ))}
          </div>
          <p className={styles.historyPrivacy}>History is saved in this browser.</p>
        </aside>

        <div className={styles.chatArea}>
          <div className={styles.scopeBar}>
            <span>DASHBOARD FILTERS</span>
            <b>{filters.brand === 'all' ? 'All brands' : filters.brand}</b>
            <b>{filters.country === 'all' ? 'All countries' : filters.country}</b>
            <b>{filters.timezone}</b>
          </div>

          <div className={styles.messages} aria-live="polite">
            {messages.map((message) => (
              <div key={message.id} className={`${styles.messageRow} ${message.role === 'user' ? styles.messageRowUser : ''}`}>
                {message.role === 'assistant' && <div className={styles.miniAvatar}>✦</div>}
                <div className={`${styles.bubble} ${message.role === 'user' ? styles.userBubble : styles.assistantBubble}`}>
                  <MessageContent content={message.content} answer={message.role === 'assistant' && !!message.question} />
                  <AnswerVisual message={message} />
                  {message.clarification?.length ? (
                    <div className={styles.clarificationChoices} aria-label="Choose a question to clarify">
                      {message.clarification.map((choice) => <button type="button" key={choice} disabled={loading} onClick={() => submit(choice)}>{choice}</button>)}
                    </div>
                  ) : null}
                  {message.question && (
                    <>
                      <div className={styles.answerMeta}>
                        <span>{answerModeLabel(message)}</span>
                        <span>{message.generatedAt ? new Date(message.generatedAt).toLocaleString('en-GB') : ''}</span>
                      </div>
                      <details className={styles.evidence}>
                        <summary>Sources used <span>{message.evidence?.length || 0}</span></summary>
                        {message.evidence?.length ? message.evidence.map((source) => (
                          <div className={styles.evidenceCard} key={source.name}>
                            <div className={styles.evidenceHead}><strong>{source.name}</strong><em>{source.status}</em></div>
                            {source.facts.map((fact) => <div className={styles.evidenceFact} key={`${fact.label}-${fact.value}`}><span>{fact.label}</span><b>{fact.value}</b></div>)}
                            {source.note && <p>{source.note}</p>}
                            <small>Checked {new Date(source.updatedAt).toLocaleString('en-GB')}</small>
                          </div>
                        )) : <p className={styles.noEvidence}>{message.intent === 'outside' ? 'This question is outside the platform data scope. No external source was queried.' : message.intent === 'clarify' ? 'No source was queried yet; please clarify the platform topic.' : 'No verified live source is available for this platform topic.'}</p>}
                      </details>
                      <div className={styles.exportBar}>
                        <button type="button" onClick={() => copyAnswer(message)} aria-label="Copy answer">Copy</button>
                        <span>Export answer</span>
                        {!!message.evidence?.length && <button type="button" onClick={() => runExport('PDF', message)}>PDF</button>}
                        {!!message.evidence?.length && <button type="button" onClick={() => runExport('Excel', message)}>Excel</button>}
                        {!!message.evidence?.length && <button type="button" onClick={() => runExport('Word', message)}>Word</button>}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className={styles.messageRow}>
                <div className={styles.miniAvatar}>✦</div>
                <div className={`${styles.bubble} ${styles.assistantBubble} ${styles.thinking}`}><span /><span /><span /><em>Checking approved sources…</em></div>
              </div>
            )}
            {error && <div className={styles.error}>{error} Please try again.</div>}
            {notice && <div className={styles.notice} role="status">{notice}</div>}
            <div ref={endRef} />
          </div>

          {messages.length === 1 && (
            <div className={styles.suggestions}>
              {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => submit(suggestion)}>{suggestion}</button>)}
            </div>
          )}
          <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); submit() }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }}
              placeholder="Ask about your commerce data…"
              rows={1}
              maxLength={2000}
              aria-label="Ask Commerce Assist"
            />
            <button type="submit" disabled={!input.trim() || loading} aria-label="Send question">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-5.2 16-3.3-6.7L4 12Zm7.5 1.3L20 4" /></svg>
            </button>
          </form>
          <footer>Answers use approved commerce platform sources only.</footer>
        </div>
      </div>
    </section>
  )
}
