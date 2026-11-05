import { useId, useState, type ReactNode } from 'react'
import styles from '@/styles/Home.module.css'

type Tone = 'success' | 'warn' | 'info' | 'purple' | 'danger' | 'neutral'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`card ${styles.section}${className ? ` ${className}` : ''}`}>{children}</div>
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className={styles.sectionTitle}>{children}</div>
}

export function Stat({ label, value, sub, secondary = false }: { label: ReactNode; value: ReactNode; sub?: ReactNode; secondary?: boolean }) {
  return (
    <div className={`${styles.stat}${secondary ? ` ${styles.statSecondary}` : ''}`}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>
        {value}
        {sub != null && <span className={styles.statSub}>{sub}</span>}
      </div>
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className={styles.rows}>{children}</div>
}

export function Row({ label, children, indent = false }: { label: ReactNode; children: ReactNode; indent?: boolean }) {
  return (
    <div className={`${styles.row}${indent ? ` ${styles.rowIndent}` : ''}`}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={styles.rowValue}>{children}</div>
    </div>
  )
}

export function CheckItem({ state, children }: { state: 'pass' | 'fail' | 'unknown'; children: ReactNode }) {
  const iconClass = state === 'pass' ? 'checkPass' : state === 'fail' ? 'checkFail' : 'checkUnknown'
  const symbol = state === 'pass' ? '✓' : state === 'fail' ? '✕' : '?'
  return (
    <div className={styles.checkItem}>
      <span className={`${styles.checkIcon} ${styles[iconClass]}`}>{symbol}</span>
      <span>{children}</span>
    </div>
  )
}

/** Truncated, monospace transaction-hash link. */
export function HashLink({ hash, href, truncate = false }: { hash: string; href: string; truncate?: boolean }) {
  const display = truncate && hash.length > 28
    ? `${hash.substring(0, 16)}…${hash.substring(hash.length - 8)}`
    : hash
  return (
    <a className={styles.hashLink} href={href} target="_blank" rel="noreferrer">
      {display}
    </a>
  )
}

/**
 * Small "i" button explaining a term. Shows on hover and keyboard focus, and toggles on
 * click/tap (touch has no hover); Escape or leaving the button closes it. The text is
 * linked with aria-describedby, so screen readers read it with the button.
 */
export function InfoTip({ children, label = 'More info' }: { children: ReactNode; label?: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className={`${styles.infoTip}${open ? ` ${styles.infoTipOpen}` : ''}`}>
      <button
        type="button"
        className={styles.infoTipButton}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen(isOpen => !isOpen)}
        onBlur={() => setOpen(false)}
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}
      >
        i
      </button>
      <span role="tooltip" id={id} className={styles.infoTipBubble}>{children}</span>
    </span>
  )
}
