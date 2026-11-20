import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

export const withPdf = async <Result>(
  blob: Blob,
  signal: AbortSignal,
  use: (pdf: PDFDocumentProxy) => Promise<Result>
): Promise<Result> => {
  signal.throwIfAborted()
  const assets = new URL('./static/pdfjs/', document.baseURI)
  const asset = (name: string) => new URL(name, assets).href
  const pdfjs: typeof import('pdfjs-dist') = await import(/* webpackIgnore: true */ asset('pdf.js'))
  pdfjs.GlobalWorkerOptions.workerSrc = asset('worker.js')
  const data = new Uint8Array(await blob.arrayBuffer())
  signal.throwIfAborted()
  const task = pdfjs.getDocument({
    data,
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    useWasm: false,
  })
  const cancel = () => { void task.destroy().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const pdf = await task.promise
    return await use(pdf)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!signal.aborted) {
      await task.destroy()
    }
  }
}

export const pdfPageText = async (page: PDFPageProxy) => {
  const { items } = await page.getTextContent()
  return items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
}

export const renderPdfPage = async (page: PDFPageProxy, signal: AbortSignal): Promise<Blob> => {
  signal.throwIfAborted()
  const original = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: 1600 / Math.max(original.width, original.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const rendering = page.render({ canvas, viewport })
  const cancel = () => rendering.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await rendering.promise
    signal.throwIfAborted()
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Cannot encode PDF page')), 'image/png')
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    canvas.width = canvas.height = 0
  }
}
