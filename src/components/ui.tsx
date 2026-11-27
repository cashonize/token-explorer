import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

export function Stat({ label, value, sub, note }: { label: ReactNode; value: ReactNode; sub?: ReactNode; note?: ReactNode }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>
        {value}
        {sub != null && <span className={styles.statSub}>{sub}</span>}
      </div>
      {note != null && <div className={styles.statNote}>{note}</div>}
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className={styles.rows}>{children}</div>
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row}>
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
 * Small "i" button explaining a term. Opens on mouse hover and keyboard focus; a click or
 * tap toggles it (touch has no hover, and iOS Safari doesn't focus a tapped button, so a
 * pointerdown outside closes it too). Escape closes it however it was opened. The text is
 * linked with aria-describedby; `label` names the button, e.g. "About circulating supply".
 */
export function InfoTip({ children, label }: { children: ReactNode; label: string }) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!visible) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      setVisible(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setVisible(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [visible])

  // Keep the bubble inside the viewport: shift it sideways, and flip it below the button
  // when there's no room above
  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (!visible || !bubble) return
    bubble.style.removeProperty('--tip-shift')
    bubble.removeAttribute('data-below')
    const margin = 8
    const rect = bubble.getBoundingClientRect()
    const shift = rect.left < margin ? margin - rect.left
      : rect.right > window.innerWidth - margin ? window.innerWidth - margin - rect.right : 0
    bubble.style.setProperty('--tip-shift', `${shift}px`)
    if (rect.top < margin) bubble.setAttribute('data-below', '')
  }, [visible])

  return (
    <span
      ref={rootRef}
      className={`${styles.infoTip}${visible ? ` ${styles.infoTipOpen}` : ''}`}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setVisible(true) }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setVisible(false) }}
    >
      <button
        type="button"
        className={styles.infoTipButton}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={visible}
        onClick={() => setVisible(isVisible => !isVisible)}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setVisible(true) }}
        onBlur={() => setVisible(false)}
      >
        <span className={styles.infoTipIcon} aria-hidden="true">i</span>
      </button>
      <span ref={bubbleRef} role="tooltip" id={id} className={styles.infoTipBubble}>{children}</span>
    </span>
  )
}
