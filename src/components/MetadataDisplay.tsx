import { useState } from 'react'
import type { MetadataInfo } from '@/interfaces'
import { ipfsToGatewayUrl } from '@/utils/utils'
import styles from '@/styles/Home.module.css'
import { Badge } from './ui'

interface MetadataDisplayProps {
  metadataInfo: MetadataInfo | undefined
  tokenIconUri: string
  tokenType: string
  network: 'mainnet' | 'chipnet'
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  )
}

export function MetadataDisplay({ metadataInfo, tokenIconUri, tokenType, network }: MetadataDisplayProps) {
  const loadingMetadata = metadataInfo?.metaDataLocation === undefined
  const noMetadata = metadataInfo?.metaDataLocation === ""
  const tokenMetadata = metadataInfo?.tokenMetadata

  const otherUriKeys = tokenMetadata?.uris
    ? Object.keys(tokenMetadata.uris).filter(uri => uri !== "icon" && uri !== "image" && uri !== "web")
    : []

  // Remember which icon URL failed to load, so an icon change while mounted gets a fresh try
  const [failedIconUri, setFailedIconUri] = useState<string | null>(null)

  const hasIcon = (tokenMetadata?.uris?.icon || tokenMetadata?.uris?.image) && tokenIconUri && failedIconUri !== tokenIconUri

  return (
    <div className={`card ${styles.section}`}>
      <div className={styles.tokenHeader}>
        {hasIcon ? (
          <img className="tokenImage" src={tokenIconUri} alt={tokenMetadata?.name ?? 'token icon'} onError={() => setFailedIconUri(tokenIconUri)} />
        ) : (
          <div className="tokenImage" style={{ aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '2rem', fontWeight: 700 }}>
            {(tokenMetadata?.name ?? '?').charAt(0).toUpperCase()}
          </div>
        )}

        <div className={styles.tokenHeaderMain}>
          <div className={styles.tokenName}>
            {tokenMetadata?.name ?? (loadingMetadata ? 'Loading…' : 'Untitled token')}
            {tokenMetadata?.token?.symbol && (
              <span className={styles.tokenSymbol}>{tokenMetadata.token.symbol}</span>
            )}
          </div>

          <div className={styles.chipRow}>
            <Badge tone="info">{tokenType}</Badge>
            {network === 'chipnet' && <Badge tone="warn">chipnet</Badge>}
            {tokenMetadata?.token?.decimals !== undefined && (
              <Badge tone="neutral">{tokenMetadata.token.decimals} decimals</Badge>
            )}
            {metadataInfo?.isOtrVerified && <Badge tone="success">OTR verified</Badge>}
          </div>

          {loadingMetadata && (
            <div className={styles.tokenDescription}>Loading metadata…</div>
          )}
          {noMetadata && (
            <div className={styles.tokenDescription}>This token has no BCMR metadata linked on-chain.</div>
          )}
          {tokenMetadata?.description && (
            <div className={styles.tokenDescription}>{tokenMetadata.description}</div>
          )}

          {tokenMetadata?.uris && (tokenMetadata.uris.web || otherUriKeys.length > 0) && (
            <div className={styles.chipRow}>
              {tokenMetadata.uris.web && (
                <a className={styles.chip} href={ipfsToGatewayUrl(tokenMetadata.uris.web)} target="_blank" rel="noreferrer">
                  <GlobeIcon /> Website
                </a>
              )}
              {otherUriKeys.map(uriKey => {
                const uri = tokenMetadata.uris?.[uriKey]
                return (
                  <a className={styles.chip} key={uriKey} href={uri && ipfsToGatewayUrl(uri)} target="_blank" rel="noreferrer">
                    <LinkIcon /> {uriKey}
                  </a>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
