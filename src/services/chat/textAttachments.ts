import { DOCX_MIME, XLSX_MIME, type LocalTextMime } from '../attachments.js'
import { readArchive } from './history/zipReader.js'
import { decodeText, readOfficeXml } from './officeXml.js'
import { readSpreadsheetText } from './spreadsheetAttachments.js'

const DOCX_BODY = 'word/document.xml'
const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])

const excerpt = (text: string, limit: number, partial = false) => ({
  text: text.length > limit ? text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : text,
  truncated: partial || text.length > limit,
})

const readWordBody = async (file: Blob, signal: AbortSignal) => {
  for await (const entry of readArchive(file, (path) => path === DOCX_BODY)) {
    return readOfficeXml(entry, signal)
  }
  throw new Error('Word document body is missing')
}

const readWordText = async (file: Blob, limit: number, signal: AbortSignal) => {
  const root = await readWordBody(file, signal)
  const namespace = root.namespaceURI ?? ''
  const body = root.getElementsByTagNameNS(namespace, 'body')[0]
  if (root.localName !== 'document' || !WORD_NAMESPACES.has(namespace) || !body) {
    throw new Error('Invalid Word document body')
  }

  const walker = root.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_ELEMENT)
  const parts: string[] = []
  let length = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as Element
    if (element.namespaceURI !== namespace) {
      continue
    }
    const tag = element.localName
    const text = tag === 't' ? element.textContent ?? ''
      : tag === 'tab' ? '\t'
      : tag === 'br' || tag === 'cr' || (tag === 'p' && length > 0) ? '\n' : ''
    if (text) {
      // Keep one extra code unit to detect truncation and protect surrogate pairs.
      parts.push(text.slice(0, limit + 1 - length))
      length += text.length
      if (length > limit) {
        break
      }
    }
  }
  return excerpt(parts.join(''), limit)
}

export const readTextAttachment = async (file: Blob, mime: LocalTextMime, limit: number, signal: AbortSignal) => {
  signal.throwIfAborted()
  if (limit <= 0) {
    return { text: '', truncated: file.size > 0 }
  }
  if (mime === DOCX_MIME) {
    return readWordText(file, limit, signal)
  }
  if (mime === XLSX_MIME) {
    return readSpreadsheetText(file, limit, signal)
  }
  const bytes = new Uint8Array(await file.slice(0, limit * 4 + 4).arrayBuffer())
  signal.throwIfAborted()
  const partial = bytes.length < file.size
  return excerpt(decodeText(bytes, partial), limit, partial)
}
