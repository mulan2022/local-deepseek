const lines = [
  'Into the Singularity',
  'Do not go gentle into that good night',
  'Gravity across dimensions',
  'At the Edge of Time',
  'No escape for light. No limit for mind',
  'Where Light Stays',
] as const

/** Select once per page load, including when the user returns to the welcome screen. */
export const welcomeLine = lines[Math.floor(Math.random() * lines.length)]
