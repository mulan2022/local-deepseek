import { useId } from 'react'

/**
 * App mark: an event horizon with its lensed far side bent over the top and the accretion disk crossing in
 * front. Same geometry as the Android launcher icon (android/res/drawable/ic_launcher_foreground.xml).
 */
export const BrandMark = ({ className, size = 26 }: { className?: string; size?: number }) => {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const band = 'M24,56 a30,8.5 0 1,0 60,0 a30,8.5 0 1,0 -60,0 Z M33,54.8 a21,4.4 0 1,0 42,0 a21,4.4 0 1,0 -42,0 Z'
  return (
    <svg className={className} width={size} height={size} viewBox="20 20 68 68" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}glow`} cx="54" cy="54" r="34" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff8a4c" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#ff7b42" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ff7b42" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}lens`} x1="54" y1="32.5" x2="54" y2="71.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff1d6" />
          <stop offset="0.35" stopColor="#ffc46b" />
          <stop offset="0.62" stopColor="#ff7b42" stopOpacity="0.8" />
          <stop offset="1" stopColor="#e85a2c" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={`${id}disk`} x1="24" y1="0" x2="84" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffc46b" />
          <stop offset="0.2" stopColor="#fff1d6" />
          <stop offset="0.42" stopColor="#ffc46b" />
          <stop offset="0.68" stopColor="#ff7b42" />
          <stop offset="0.9" stopColor="#e85a2c" />
          <stop offset="1" stopColor="#8db4ff" />
        </linearGradient>
        <clipPath id={`${id}back`}><rect x="0" y="0" width="108" height="56" /></clipPath>
        <clipPath id={`${id}front`}><rect x="0" y="56" width="108" height="52" /></clipPath>
      </defs>
      <circle cx="54" cy="54" r="34" fill={`url(#${id}glow)`} />
      <path fill={`url(#${id}lens)`} fillRule="evenodd"
        d="M34.5,52 a19.5,19.5 0 1,0 39,0 a19.5,19.5 0 1,0 -39,0 Z M40.8,54.6 a13.2,13.2 0 1,0 26.4,0 a13.2,13.2 0 1,0 -26.4,0 Z" />
      <path clipPath={`url(#${id}back)`} fill={`url(#${id}disk)`} fillRule="evenodd" opacity="0.85" d={band} />
      <circle cx="54" cy="54" r="11.5" fill="#05060b" />
      <circle cx="54" cy="54" r="11.9" fill="none" stroke="#fff1d6" strokeWidth="1.2" strokeOpacity="0.9" />
      <path clipPath={`url(#${id}front)`} fill={`url(#${id}disk)`} fillRule="evenodd" d={band} />
    </svg>
  )
}
