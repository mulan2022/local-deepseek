import { openArchive } from './history/zipReader.js'
import { MAX_OFFICE_XML_BYTES, readOfficeXml } from './officeXml.js'

type Archive = Awaited<ReturnType<typeof openArchive>>
const PACKAGE_ORIGIN = 'https://office-attachment.invalid'
const WORKBOOK_RELATIONSHIPS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]
const MAX_CELL_TEXT = 4000
const BUILTIN_NUMBER_FORMATS = new Map([
  ['1', '0'], ['2', '0.00'], ['3', '#,##0'], ['4', '#,##0.00'],
  ['9', '0%'], ['10', '0.00%'], ['11', '0.00E+00'], ['12', '# ?/?'], ['13', '# ??/??'],
  ['14', 'mm-dd-yy'], ['15', 'd-mmm-yy'], ['16', 'd-mmm'], ['17', 'mmm-yy'],
  ['18', 'h:mm AM/PM'], ['19', 'h:mm:ss AM/PM'], ['20', 'h:mm'], ['21', 'h:mm:ss'], ['22', 'm/d/yy h:mm'],
  ['37', '#,##0 ;(#,##0)'], ['38', '#,##0 ;[Red](#,##0)'],
  ['39', '#,##0.00;(#,##0.00)'], ['40', '#,##0.00;[Red](#,##0.00)'],
  ['45', 'mm:ss'], ['46', '[h]:mm:ss'], ['47', 'mmss.0'], ['48', '##0.0E+0'], ['49', '@'],
])

const child = (parent: Element, name: string) =>
  Array.from(parent.children).find((element) => element.localName === name)

const textOf = (parent: Element | undefined) =>
  Array.from(parent?.children ?? []).map((element) => {
    if (element.localName === 't') {
      return element.textContent
    }
    // Rich strings may also contain phonetic annotations, which are separate from the value.
    return element.localName === 'r' ? child(element, 't')?.textContent : ''
  }).join('')

const getPart = async (archive: Archive, path: string, signal: AbortSignal) => {
  signal.throwIfAborted()
  for await (const entry of archive((name) => name === path)) {
    return entry
  }
  throw new Error('Missing spreadsheet package part')
}

const xmlAt = async (archive: Archive, path: string, signal: AbortSignal) =>
  readOfficeXml(await getPart(archive, path, signal), signal)

const relationships = (root: Element, source: string) => {
  const result = new Map<string, { path: string; type: string }>()
  for (const element of root.children) {
    const id = element.getAttribute('Id')
    const type = element.getAttribute('Type')
    const target = element.getAttribute('Target')
    if (element.localName !== 'Relationship' || !id || !type || !target ||
        element.getAttribute('TargetMode') === 'External') {
      continue
    }
    const prefix = WORKBOOK_RELATIONSHIPS.find((namespace) => type.startsWith(`${namespace}/`))
    if (!prefix) {
      continue
    }
    const url = new URL(target, `${PACKAGE_ORIGIN}/${source}`)
    if (url.origin === PACKAGE_ORIGIN && !url.search && !url.hash) {
      result.set(id, { path: decodeURIComponent(url.pathname.slice(1)).normalize('NFC'), type: type.slice(prefix.length + 1) })
    }
  }
  return result
}

const relationshipId = (sheet: Element) => WORKBOOK_RELATIONSHIPS
  .map((namespace) => sheet.getAttributeNS(namespace, 'id')).find(Boolean) ?? ''

const relationshipPath = (path: string) => {
  const slash = path.lastIndexOf('/') + 1
  return `${path.slice(0, slash)}_rels/${path.slice(slash)}.rels`
}

const columnName = (index: number) => {
  let column = ''
  for (; index > 0; index = Math.floor((index - 1) / 26)) {
    column = String.fromCharCode(65 + (index - 1) % 26) + column
  }
  return column
}

const columnIndex = (name: string) => [...name].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0)

const parseNumberFormats = (root: Element | undefined) => {
  const custom = new Map(Array.from(root ? child(root, 'numFmts')?.children ?? [] : [], (format) =>
    [format.getAttribute('numFmtId'), format.getAttribute('formatCode')] as const))
  return Array.from(root ? child(root, 'cellXfs')?.children ?? [] : [], (style) => {
    const id = style.getAttribute('numFmtId')
    return id && id !== '0' ? custom.get(id) ?? BUILTIN_NUMBER_FORMATS.get(id) ?? `Excel built-in format ${id}` : undefined
  })
}

const readCell = (cell: Element, strings: Element[], formats: ReturnType<typeof parseNumberFormats>) => {
  const type = cell.getAttribute('t') ?? 'n'
  const stored = child(cell, 'v')?.textContent || null
  const formula = child(cell, 'f')
  const value = type === 'inlineStr' ? textOf(child(cell, 'is'))
    : type === 's' && stored !== null ? textOf(strings[Number(stored)])
    : type === 'b' && stored !== null ? stored === '1' || stored === 'true'
    : type === 'n' && stored !== null && Number.isFinite(Number(stored)) ? Number(stored) : stored
  const format = type === 'n' ? formats[Number(cell.getAttribute('s') ?? 0)] : undefined
  const expression = formula?.textContent || undefined
  return { value, formula: expression, hasFormula: !!formula, format }
}

export const readSpreadsheetText = async (file: Blob, limit: number, signal: AbortSignal) => {
  const archive = await openArchive(file)
  const packageRels = relationships(await xmlAt(archive, '_rels/.rels', signal), '')
  const main = [...packageRels.values()].find(({ type }) => type === 'officeDocument')
  if (!main) {
    throw new Error('Spreadsheet workbook part is missing')
  }
  const workbook = await xmlAt(archive, main.path, signal)
  const sheets = child(workbook, 'sheets')
  if (workbook.localName !== 'workbook' || !sheets) {
    throw new Error('Invalid spreadsheet workbook')
  }
  const parts = relationships(await xmlAt(archive, relationshipPath(main.path), signal), main.path)
  const stringPart = [...parts.values()].find(({ type }) => type === 'sharedStrings')
  const stylePart = [...parts.values()].find(({ type }) => type === 'styles')
  const strings = stringPart ? Array.from((await xmlAt(archive, stringPart.path, signal)).children)
    .filter((item) => item.localName === 'si') : []
  const formats = parseNumberFormats(stylePart ? await xmlAt(archive, stylePart.path, signal) : undefined)
  const date1904 = child(workbook, 'workbookPr')?.getAttribute('date1904')

  const lines: string[] = []
  let length = 0
  let truncated = false
  const append = (line: object) => {
    const text = JSON.stringify(line)
    const nextLength = length + text.length + Number(lines.length > 0)
    if (nextLength > limit) {
      return false
    }
    lines.push(text)
    length = nextLength
    return true
  }
  const skipped = () => ({ text: lines.join('\n'), truncated: true })
  if (!append({ workbook: 'Excel', dateSystem: date1904 === '1' || date1904 === 'true' ? 1904 : 1900,
    formulaValues: 'cached',
  })) {
    return skipped()
  }

  for (const sheet of sheets.children) {
    const part = parts.get(relationshipId(sheet))
    if (part?.type !== 'worksheet') {
      continue
    }
    const entry = await getPart(archive, part.path, signal)
    const oversized = entry.size > MAX_OFFICE_XML_BYTES
    if (!append({ sheet: sheet.getAttribute('name'), state: sheet.getAttribute('state') ?? undefined,
      ...(oversized ? { note: 'Worksheet exceeds the local XML size limit.' } : {}),
    })) {
      return skipped()
    }
    if (oversized) {
      truncated = true
      continue
    }

    const worksheet = await readOfficeXml(entry, signal)
    const data = child(worksheet, 'sheetData')
    if (worksheet.localName !== 'worksheet' || !data) {
      throw new Error('Invalid spreadsheet worksheet')
    }
    let rowNumber = 0
    for (const row of data.children) {
      const firstAddress = row.firstElementChild?.getAttribute('r')
      rowNumber = Number(row.getAttribute('r') ?? firstAddress?.match(/\d+$/)?.[0]) || rowNumber + 1
      let column = 0
      for (const cell of row.children) {
        if (cell.localName !== 'c') {
          continue
        }
        const address = cell.getAttribute('r')?.match(/^([A-Z]{1,3})[1-9]\d{0,6}$/)
        column = address ? columnIndex(address[1]) : column + 1
        const { value, formula, hasFormula, format } = readCell(cell, strings, formats)
        if (value === null && !hasFormula) {
          continue
        }
        const shortened = typeof value === 'string' && value.length > MAX_CELL_TEXT
        truncated ||= shortened
        if (!append({ cell: address?.[0] ?? `${columnName(column)}${rowNumber}`,
          value: shortened ? value.slice(0, MAX_CELL_TEXT).replace(/[\uD800-\uDBFF]$/, '') : value,
          formula, format, ...(value === null && hasFormula ? { cachedValueMissing: true } : {}),
          ...(shortened ? { truncated: true } : {}),
        })) {
          return skipped()
        }
      }
    }
  }
  return { text: lines.join('\n'), truncated }
}
