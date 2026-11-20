const closingTag = '</SCREEN_OBSERVATION>'

const observationParts = (task: string) => {
  const opening = /^<SCREEN_OBSERVATION(?: [^\r\n]*)?>\r?\n/m.exec(task)
  const end = task.lastIndexOf(`\n${closingTag}`)
  if (!opening || end < opening.index + opening[0].length) {
    return undefined
  }
  return {
    tag: opening[0].trimEnd(),
    text: task.slice(opening.index + opening[0].length, end).trim(),
    legacy: opening.index > 0,
  }
}

export const observationDisplayText = (task: string) => observationParts(task)?.text ?? ''

/** Replay the OCR data without the instructions persisted with older events. */
export const observationRequestTask = (task: string) => {
  const parts = observationParts(task)
  if (!parts) {
    return ''
  }
  const text = parts.legacy ? parts.text
    .replace(/^\[图片 (?=\S+ · )/gm, '[Image ')
    .replace(/^（没有可靠文字）$/gm, '(No reliable text)') : parts.text
  return `${parts.tag}\n${text}\n${closingTag}`
}
