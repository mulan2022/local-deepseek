import { readEntry, type ArchiveEntry } from './history/zipReader.js'

export const MAX_OFFICE_XML_BYTES = 8 * 1024 * 1024

export const decodeText = (bytes: Uint8Array, partial = false) => {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: partial })
}

export const readOfficeXml = async (entry: ArchiveEntry, signal: AbortSignal) => {
  signal.throwIfAborted()
  if (entry.size > MAX_OFFICE_XML_BYTES) {
    throw new Error('Office XML part exceeds the local size limit')
  }
  const part = await readEntry(entry)
  const xml = decodeText(new Uint8Array(await part.arrayBuffer()))
  signal.throwIfAborted()
  if (xml.includes('<!DOCTYPE')) {
    throw new Error('Unexpected doctype in Office XML')
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagNameNS('http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror').length) {
    throw new Error('Invalid Office XML')
  }
  return document.documentElement
}
