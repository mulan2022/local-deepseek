type AndroidFiles = {
  begin(): boolean
  append(chunk: string): boolean
  chooseDestination(name: string, type: string): boolean
  cancel(): void
}

const androidFiles = () =>
  (window as Window & { AndroidLocalFiles?: AndroidFiles }).AndroidLocalFiles

export const isAndroidApp = () => androidFiles() !== undefined

export const saveLocalFile = async (name: string, blob: Blob) => {
  const files = androidFiles()
  if (!files) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return
  }

  if (!files.begin()) {
    throw new Error('无法创建导出文件')
  }
  const chunkSize = 32 * 1024
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const part = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer())
      if (!files.append(btoa(String.fromCharCode(...part)))) {
        throw new Error('无法写入导出文件')
      }
    }
    if (!files.chooseDestination(name, blob.type || 'application/octet-stream')) {
      throw new Error('无法打开保存窗口')
    }
  } catch (error) {
    files.cancel()
    throw error
  }
}
