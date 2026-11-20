import clsx from 'clsx'
import styles from './Cosmos.module.css'

/** Slow accretion light behind the new-chat screen. Decorative and never takes pointer input. */
export const Cosmos = () => (
  <div className={styles.cosmos} aria-hidden="true">
    <div className={styles.flow} />
    <div className={styles.counterFlow} />
    <div className={styles.grain} />
  </div>
)

/** New-chat hero: tilted accretion disk, its lensed far side bent over the top, and the photon ring. */
export const BlackHole = ({ className }: { className?: string }) => (
  <div className={clsx(styles.hole, className)} aria-hidden="true">
    <div className={styles.halo} />
    <div className={clsx(styles.disk, styles.far)}><i /><i /></div>
    <div className={styles.lens}><i /></div>
    <div className={styles.horizon} />
    <div className={clsx(styles.disk, styles.near)}><i /><i /></div>
  </div>
)
