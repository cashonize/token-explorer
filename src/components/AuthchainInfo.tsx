import type { TokenInfo, MetadataInfo, AuthchainEntry, Diagnostic, ElectrumVerification } from '@/interfaces'
import { formatTimestamp } from '@/utils/utils'
import { BLOCK_EXPLORER_URL } from '@/constants'
import { parseOpReturnPushes } from '@/utils/bcmr'
import { binToUtf8, hexToBin } from '@bitauth/libauth'
import styles from '@/styles/Home.module.css'
import { Badge, SectionTitle, Row, Rows, CheckItem, HashLink } from './ui'

interface AuthchainInfoProps {
  tokenInfo: TokenInfo
  metadataInfo: MetadataInfo | undefined
  electrumVerification?: ElectrumVerification
}

const getBaseDomain = (url: string) => {
  try {
    const parts = new URL(url).hostname.split('.')
    return parts.slice(-2).join('.')
  } catch { return undefined }
}

function AuthchainTimeline({ entries, genesisTx, authHead, authHeadBurned }: { entries?: AuthchainEntry[], genesisTx?: string, authHead?: string, authHeadBurned?: boolean }) {
  if (!entries || entries.length === 0) return null

  return (
    <details className="disclosure">
      <summary>
        Authchain history ({entries.length} transaction{entries.length !== 1 ? 's' : ''})
      </summary>
      <div className="disclosure-body">
        <div style={{ marginTop: '10px' }}>
          {entries.map(({ publication, ...entry }, index) => (
            <div key={entry.txHash} className={styles.entry}>
              <div className={styles.entryHead}>
                <span className={styles.entryIndex}>#{index}</span>
                <Badge tone={entry.isMetadataUpdate ? 'success' : 'warn'}>
                  {entry.isMetadataUpdate ? 'metadata update' : 'identity transfer'}
                </Badge>
                {entry.txHash === genesisTx && <Badge tone="info">token genesis</Badge>}
                {entry.txHash === authHead && <Badge tone="purple">authhead</Badge>}
                {entry.txHash === authHead && authHeadBurned && <Badge tone="danger">burned</Badge>}
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>tx:</span>{' '}
                <HashLink hash={entry.txHash} href={BLOCK_EXPLORER_URL + entry.txHash} truncate />
              </div>
              {entry.timestamp != null && (
                <div style={{ color: 'var(--text-muted)' }}>{formatTimestamp(entry.timestamp)}</div>
              )}
              {publication && (
                <details className="disclosure-inline">
                  <summary>BCMR details</summary>
                  <div style={{ marginLeft: '8px', fontSize: '0.9em', marginTop: '4px' }}>
                    {publication.contentHash && !publication.isCidOnly && <div style={{ wordBreak: 'break-all' }}>content hash: <span className="mono">{publication.contentHash}</span></div>}
                    {publication.isCidOnly && <div>no content hash (CID-only publication, a non-spec format)</div>}
                    {publication.httpsUrl && (
                      <div>https url:{' '}
                        <a href={publication.httpsUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                          {publication.httpsUrl}
                        </a>
                      </div>
                    )}
                    {publication.uris.length > 0 && (
                      <div>uri{publication.uris.length > 1 ? 's' : ''}: {publication.uris.join(', ')}</div>
                    )}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}

const diagnosticLabels: Record<string, string> = {
  fetch_failed: 'Fetch Failed',
  http_error: 'HTTP Error',
  invalid_json: 'Invalid JSON',
  schema_invalid: 'Schema Invalid',
  hash_mismatch: 'Hash Mismatch',
  unresolvable_publication: 'Unresolvable Publication'
}

function LatestPublicationOutput({ migrations, lastMetadataUpdateTimestamp }: {
  migrations?: AuthchainEntry[]
  lastMetadataUpdateTimestamp?: number
}) {
  // Find the last metadata update migration that has opReturnHex
  const latestPublication = migrations ? [...migrations].reverse().find(m => m.isMetadataUpdate && m.opReturnHex) : undefined
  if (!latestPublication?.opReturnHex) return null

  const rawHex = latestPublication.opReturnHex
  const pushes = parseOpReturnPushes(rawHex)
  // pushes[0] = "BCMR" (42434d52), pushes[1] = content hash, pushes[2+] = URIs

  return (
    <>
      {lastMetadataUpdateTimestamp != null && (
        <Rows>
          <Row label="Last metadata update">{formatTimestamp(lastMetadataUpdateTimestamp)}</Row>
        </Rows>
      )}
      <details className="disclosure" style={{ marginTop: '14px' }}>
        <summary>Latest publication output</summary>
        <div className="disclosure-body">
          <div style={{ marginTop: '10px' }}>
            <strong>raw hex:</strong>
            <div className="mono" style={{ wordBreak: 'break-all', marginTop: '2px' }}>{rawHex}</div>
          </div>
          {pushes.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <strong>data pushes:</strong>
              {pushes.map((push, i) => (
                <div key={i} className="mono" style={{ wordBreak: 'break-all', marginTop: '2px' }}>
                  [{i}] {push}
                </div>
              ))}
            </div>
          )}
          {pushes.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <strong>decoded:</strong>
              {pushes.map((push, i) => (
                <div key={i} style={{ wordBreak: 'break-all', marginTop: '2px' }}>
                  [{i}] {i === 1 && !latestPublication.publication?.isCidOnly ? `<${push.length / 2}_byte_hash>` : binToUtf8(hexToBin(push))}
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </>
  )
}

function DiagnosticsSection({ diagnostics }: { diagnostics?: Diagnostic[] }) {
  if (!diagnostics || diagnostics.length === 0) return null
  return (
    <details className="disclosure" style={{ marginTop: '14px', borderColor: 'var(--warn-border)' }}>
      <summary style={{ color: 'var(--warn-text)' }}>
        Diagnostics ({diagnostics.length} issue{diagnostics.length !== 1 ? 's' : ''})
      </summary>
      <div className="disclosure-body">
        <div style={{ marginTop: '10px' }}>
          {diagnostics.map((diag, i) => (
            <div key={i} className="note note-warn" style={{ marginBottom: '8px' }}>
              <div><strong>{diagnosticLabels[diag.type] ?? diag.type}</strong></div>
              <div style={{ marginTop: '2px' }}>{diag.message}</div>
              {diag.details && (
                <pre className="mono" style={{
                  marginTop: '6px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  backgroundColor: 'var(--bg-accent)',
                  padding: '6px 8px',
                  borderRadius: '4px'
                }}>{diag.details}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}

export function AuthchainInfo({ tokenInfo, metadataInfo, electrumVerification }: AuthchainInfoProps) {
  const webUrl = metadataInfo?.tokenMetadata?.uris?.web
  const bcmrBaseDomain = metadataInfo?.httpsUrl ? getBaseDomain(metadataInfo.httpsUrl) : undefined
  const webBaseDomain = webUrl ? getBaseDomain(webUrl) : undefined
  const bcmrOriginMatchesWeb = bcmrBaseDomain && webBaseDomain ? bcmrBaseDomain === webBaseDomain : undefined

  const hasChecks = metadataInfo && (
    metadataInfo.isSchemaValid !== undefined ||
    (metadataInfo.authchainUpdates !== undefined && metadataInfo.authchainUpdates > 0) ||
    bcmrOriginMatchesWeb ||
    metadataInfo.isOtrVerified ||
    tokenInfo.usesAuthGuard
  )

  return (
    <div className={`card ${styles.section}`}>
      <SectionTitle>Authchain &amp; metadata</SectionTitle>

      <Rows>
        <Row label="Genesis transaction">
          <HashLink hash={tokenInfo.genesisTx} href={BLOCK_EXPLORER_URL + tokenInfo.genesisTx} />
        </Row>
        <Row label="Genesis timestamp">
          {tokenInfo.genesisTxTimestamp ? formatTimestamp(tokenInfo.genesisTxTimestamp) : 'N/A'}
        </Row>

        {metadataInfo && (
          <>
            <Row label="Authchain length">{tokenInfo.authchainLength}</Row>
            <Row label="Metadata updates">{metadataInfo.authchainUpdates}</Row>
            <Row label="AuthHead txid">
              <HashLink hash={tokenInfo.authHead ?? ''} href={BLOCK_EXPLORER_URL + tokenInfo.authHead} />
              {tokenInfo.authHeadBurned && (
                <div style={{ marginTop: '4px' }}><Badge tone="danger">burned — identity output is OP_RETURN (unspendable)</Badge></div>
              )}
              {!tokenInfo.authHeadBurned && electrumVerification?.authHeadUnspent === true && (
                <div className="note note-success" style={{ marginTop: '8px' }}>authhead UTXO confirmed unspent via Electrum</div>
              )}
              {!tokenInfo.authHeadBurned && electrumVerification?.authHeadUnspent === false && (
                <div className="note note-warn" style={{ marginTop: '8px' }}>authhead UTXO not found via Electrum — may be spent (Chaingraph stale)</div>
              )}
            </Row>
            {tokenInfo.authHeadTimestamp != null && (
              <Row label="Last authchain update">
                {formatTimestamp(tokenInfo.authHeadTimestamp)}{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  ({tokenInfo.authHeadIsMetadataUpdate ? 'metadata update' : 'identity transfer'})
                </span>
              </Row>
            )}
            {tokenInfo.authHeadAddress && (
              <Row label="AuthHead address"><span className="mono">{tokenInfo.authHeadAddress}</span></Row>
            )}
            {metadataInfo.httpsUrl && (
              <Row label="Metadata location">
                <a href={metadataInfo.httpsUrl} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                  {metadataInfo.metaDataLocation}
                </a>
              </Row>
            )}
          </>
        )}
      </Rows>

      {metadataInfo && (
        <>
          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <LatestPublicationOutput
              migrations={tokenInfo.authchainMigrations}
              lastMetadataUpdateTimestamp={
                !tokenInfo.authHeadIsMetadataUpdate
                  ? [...(tokenInfo.authchainMigrations ?? [])].reverse().find(m => m.isMetadataUpdate)?.timestamp
                  : undefined
              }
            />

            <AuthchainTimeline
              entries={tokenInfo.authchainMigrations}
              genesisTx={tokenInfo.genesisTx}
              authHead={tokenInfo.authHead}
              authHeadBurned={tokenInfo.authHeadBurned}
            />
          </div>

          {hasChecks && (
            <div style={{ marginTop: '20px' }}>
              <SectionTitle>Verification</SectionTitle>
              <div className={styles.checklist}>
                {metadataInfo.isSchemaValid !== undefined && (
                  <CheckItem state={metadataInfo.isSchemaValid ? 'pass' : 'fail'}>BCMR schema valid</CheckItem>
                )}
                {metadataInfo.authchainUpdates !== undefined && metadataInfo.authchainUpdates > 0 && (
                  <CheckItem state={metadataInfo.metadataHashMatch ? 'pass' : metadataInfo.metadataHashMatch === false ? 'fail' : 'unknown'}>
                    Metadata hash matches on-chain commitment
                  </CheckItem>
                )}
                {bcmrOriginMatchesWeb && (
                  <CheckItem state="pass">BCMR origin matches web URL</CheckItem>
                )}
                {metadataInfo.isOtrVerified && (
                  <CheckItem state="pass">OpenTokenRegistry (OTR) verified</CheckItem>
                )}
                {tokenInfo.usesAuthGuard && (
                  <CheckItem state="pass">Uses authGuard standard</CheckItem>
                )}
              </div>
            </div>
          )}

          <DiagnosticsSection diagnostics={metadataInfo.diagnostics} />
        </>
      )}
    </div>
  )
}
