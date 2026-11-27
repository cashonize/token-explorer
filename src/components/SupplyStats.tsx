import type { TokenInfo, ExtendedTokenInfo, MetadataInfo, NftCategory, ElectrumVerification, ReservedSupplyUtxo, BurnEntry } from '@/interfaces'
import { lockingBytecodeToCashAddress, hexToBin } from '@bitauth/libauth'
import styles from '@/styles/Home.module.css'
import { BLOCK_EXPLORER_URL } from '@/constants'
import { formatTimestamp } from '@/utils/utils'
import { useState } from 'react'
import { groupBurnsByTransaction, supplyRemovalRows, type SupplyRemovalRow } from '@/utils/burns'
import { Badge, InfoTip, SectionTitle, Stat, StatGrid, Row, Rows } from './ui'

// Burn transactions shown at first (latest first), and how many more each "Show more" adds
const INITIAL_BURN_TXS = 10
const MORE_BURN_TXS = 50

interface SupplyStatsProps {
  tokenInfo: TokenInfo
  extendedInfo: ExtendedTokenInfo | undefined
  extendedInfoError: string | undefined
  metadataInfo: MetadataInfo | undefined
  electrumVerification?: ElectrumVerification
  electrumEnabled: boolean
}

function NftParseDetails({ nfts }: { nfts: NftCategory }) {
  const types = nfts.parse.types
  const typeEntries = Object.entries(types)
  if (typeEntries.length === 0) return null

  const isSequential = !nfts.parse.bytecode
  const summaryLabel = isSequential
    ? `Sequential NFT collection (${typeEntries.length} NFT entr${typeEntries.length > 1 ? 'ies' : 'y'} defined)`
    : `Parsable BCMR metadata (${typeEntries.length} NFT type${typeEntries.length > 1 ? 's' : ''} defined)`

  return (
    <details className="disclosure">
      <summary>{summaryLabel}</summary>
      <div className="disclosure-body">
        {nfts.description && <div style={{ marginTop: '10px' }}>collection description: {nfts.description}</div>}
        {nfts.parse.bytecode && <div style={{ marginTop: '10px', wordBreak: 'break-all' }}>parse bytecode: {nfts.parse.bytecode}</div>}
        {nfts.fields && Object.keys(nfts.fields).length > 0 && (
          <div style={{ marginTop: '10px' }}>
            fields:
            {Object.entries(nfts.fields).map(([fieldId, field]) => (
              <div key={fieldId} style={{ paddingLeft: '1em' }}>
                - {field.name ?? fieldId} ({field.encoding.type}){field.description ? `: ${field.description}` : ''}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: '10px' }}>
          {typeEntries.map(([typeId, nftType]) => (
            <details key={typeId} className="disclosure-inline">
              <summary>{isSequential ? `#${typeId}` : `type "${typeId}"`}: {nftType.name}</summary>
              <div style={{ paddingLeft: '1.2em', marginTop: '4px' }}>
                {nftType.description && <div>description: {nftType.description}</div>}
                {nftType.fields && nftType.fields.length > 0 && (
                  <div>fields: {nftType.fields.join(', ')}</div>
                )}
                {nftType.uris && Object.keys(nftType.uris).length > 0 && (
                  <div>
                    uris: {Object.entries(nftType.uris).map(([key, val]) => (
                      <span key={key}> {key}: {val}</span>
                    ))}
                  </div>
                )}
                {nftType.extensions && Object.keys(nftType.extensions).length > 0 && (
                  <div>extensions: {JSON.stringify(nftType.extensions)}</div>
                )}
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>
  )
}

function ElectrumVerificationBadge({ verification }: { verification: ElectrumVerification }) {
  if (verification.error) {
    return (
      <div className="note note-muted">
        Electrum verification unavailable: {verification.error}
      </div>
    )
  }

  if (verification.verified) {
    return (
      <div className="note note-success">
        Chaingraph data verified with Electrum ({verification.totalElectrumUtxos.toLocaleString("en-GB")} UTXOs match)
      </div>
    )
  }

  return (
    <div className="note note-warn">
      <div style={{ fontWeight: 700, marginBottom: '4px' }}>
        Chaingraph data may be stale — Electrum could not confirm all UTXOs
      </div>
      <div>Chaingraph UTXOs: {verification.totalChaingraphUtxos.toLocaleString("en-GB")} — Electrum verified {verification.totalElectrumUtxos.toLocaleString("en-GB")} of those</div>
      {verification.staleCount > 0 && (
        <div>{verification.staleCount.toLocaleString("en-GB")} UTXO{verification.staleCount > 1 ? 's' : ''} in Chaingraph not confirmed by Electrum (likely already spent)</div>
      )}
      {verification.missingCount > 0 && (
        <div>{verification.missingCount.toLocaleString("en-GB")} UTXO{verification.missingCount > 1 ? 's' : ''} found by Electrum but not in Chaingraph (not yet indexed)</div>
      )}
      <div style={{ marginTop: '4px' }}>Detailed supply stats below may be inaccurate due to this stale data.</div>
    </div>
  )
}

function UtxoEntry({ utxo, network, displayTokenAmount }: { utxo: ReservedSupplyUtxo; network: 'mainnet' | 'chipnet'; displayTokenAmount: (amount: bigint) => string }) {
  const isAuthhead = !!utxo.isAuthhead
  const isCovenant = !utxo.lockingBytecode.startsWith('76a914')
  const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(utxo.lockingBytecode), prefix: network === 'chipnet' ? 'bchtest' : 'bitcoincash' })
  const address = typeof result === 'string' ? undefined : result.address
  return (
    <div className={styles.entry}>
      {(utxo.nftCapability || isCovenant || isAuthhead) && (
        <div className={styles.entryHead}>
          {utxo.nftCapability && (
            <Badge tone={utxo.nftCapability === 'minting' ? 'success' : 'warn'}>{utxo.nftCapability}</Badge>
          )}
          {isCovenant && <Badge tone="info">covenant</Badge>}
          {isAuthhead && <Badge tone="purple">authhead</Badge>}
        </div>
      )}
      <div style={{ wordBreak: 'break-all' }}>
        <span style={{ color: 'var(--text-muted)' }}>outpoint:</span> <span className="mono">{utxo.txHash}:{utxo.vout}</span>
      </div>
      {address && <div style={{ wordBreak: 'break-all' }}><span style={{ color: 'var(--text-muted)' }}>address:</span> <span className="mono">{address}</span></div>}
      <div><span style={{ color: 'var(--text-muted)' }}>FT amount:</span> {displayTokenAmount(utxo.fungibleTokenAmount)}</div>
    </div>
  )
}

const BURN_METHOD_LABEL: Record<BurnEntry['method'], string> = {
  op_return: 'OP_RETURN',
  tokenburner: 'tokenburner.cash',
}

const BURN_EXPLANATION = 'Sent to an output that can never be spent (an OP_RETURN data output or the tokenburner.cash contract), so permanently out of supply. Burning is routine for many tokens, e.g. stablecoins burn tokens when a loan is repaid or tokens are redeemed.'

const REMOVAL_LABEL: Record<SupplyRemovalRow['kind'], { label: string; tipLabel: string; tip: string }> = {
  removed: {
    label: 'Total burned',
    tipLabel: 'About total burned supply',
    tip: "Genesis supply minus all tokens still held in unspent outputs. Burn data couldn't be loaded, so this can't be split into tokens sent to a burn output and tokens no longer in any output.",
  },
  burned: {
    label: 'Sent to a burn output',
    tipLabel: 'About tokens sent to a burn output',
    tip: BURN_EXPLANATION,
  },
  withoutBurnOutput: {
    label: 'Not in any output',
    tipLabel: 'About tokens not in any output',
    tip: "Tokens a transaction spent but didn't pass on to any output, so they no longer exist. Some contracts remove tokens this way on purpose; it can also be a wallet error. The explorer can't tell which.",
  },
}

const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`

function BurnTransactionList({ burns, displayTokenAmount }: { burns: BurnEntry[]; displayTokenAmount: (amount: bigint) => string }) {
  const [shown, setShown] = useState(INITIAL_BURN_TXS)
  const transactions = groupBurnsByTransaction(burns)
  const methods = [...new Set(burns.map(burn => burn.method))]
  const singleMethod = methods.length === 1 ? methods[0] : undefined
  const listed = transactions.slice(0, shown)
  const remaining = transactions.length - listed.length
  return (
    <details className="disclosure">
      <summary>
        Burn transactions ({transactions.length.toLocaleString("en-GB")}{singleMethod ? `, all ${BURN_METHOD_LABEL[singleMethod]}` : ''})
      </summary>
      <div className="disclosure-body">
        <div className={styles.burnList} style={{ marginTop: '10px' }}>
          {listed.map(tx => {
            const amount = [
              tx.fungibleTokenAmount > 0n ? displayTokenAmount(tx.fungibleTokenAmount) : null,
              tx.nftCount > 0 ? `${tx.nftCount} NFT${tx.nftCount === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' + ')
            return (
              <a key={tx.txHash} className={styles.burnRow} href={BLOCK_EXPLORER_URL + tx.txHash} target="_blank" rel="noreferrer">
                <span className={styles.burnRowDate}>{tx.timestamp != null ? formatTimestamp(tx.timestamp) : 'unconfirmed'}</span>
                <span aria-hidden="true" className={styles.burnRowSep}>·</span>
                <span className={styles.burnRowAmount}>
                  {amount}
                  {!singleMethod && tx.methods.map(method => <span key={method} style={{ marginLeft: '6px' }}><Badge>{BURN_METHOD_LABEL[method]}</Badge></span>)}
                </span>
                <span className={styles.burnRowTx}>{shortHash(tx.txHash)} ↗</span>
              </a>
            )
          })}
        </div>
        {remaining > 0 && (
          <button type="button" className={styles.showMore} onClick={() => setShown(count => count + MORE_BURN_TXS)}>
            Show {Math.min(MORE_BURN_TXS, remaining).toLocaleString("en-GB")} more
            <span style={{ color: 'var(--text-muted)' }}> ({remaining.toLocaleString("en-GB")} not shown)</span>
          </button>
        )}
      </div>
    </details>
  )
}

export function SupplyStats({ tokenInfo, extendedInfo, extendedInfoError, metadataInfo, electrumVerification, electrumEnabled }: SupplyStatsProps) {
  const decimals = metadataInfo?.tokenMetadata?.token?.decimals ?? 0
  const symbol = metadataInfo?.tokenMetadata?.token?.symbol ?? ''
  const nfts = metadataInfo?.tokenMetadata?.token?.nfts

  const displayTokenAmount = (amount: bigint) => {
    if (decimals === 0) return amount.toLocaleString("en-GB") + (symbol ? ' ' + symbol : '')
    const negative = amount < 0n
    const absAmount = negative ? -amount : amount
    const divisor = 10n ** BigInt(decimals)
    const whole = absAmount / divisor
    const fractional = absAmount % divisor
    const wholeStr = whole.toLocaleString("en-GB")
    const fractionalStr = fractional.toString().padStart(decimals, '0').replace(/0+$/, '')
    const sign = negative ? '-' : ''
    if (fractionalStr === '') return `${sign}${wholeStr}${symbol ? ' ' + symbol : ''}`
    return `${sign}${wholeStr}.${fractionalStr}${symbol ? ' ' + symbol : ''}`
  }

  const hasFT = tokenInfo.genesisSupplyFT > 0n
  const showPrimarySupply = !tokenInfo.issuingUtxosError && !!metadataInfo?.tokenMetadata && hasFT

  // Provable burns (OP_RETURN outputs, tokenburner.cash), only used for the "Removed from supply"
  // breakdown; the headline figures are as before (naive circulating, then burned once holder data is in).
  const knownBurns = tokenInfo.knownBurns
  const hasKnownBurns = !!knownBurns && (knownBurns.burnedFT > 0n || knownBurns.burnedNFTs > 0)

  // Resolve reserved supply (Chaingraph, or Electrum-verified) and naive circulating = genesis − reserved.
  const supply = (() => {
    if (!showPrimarySupply) return null
    const withCirculating = <T extends { reservedFT: bigint }>(figures: T) =>
      ({ ...figures, naiveCirculating: tokenInfo.genesisSupplyFT - figures.reservedFT })
    if (!electrumVerification) {
      if (electrumEnabled) return { state: extendedInfo ? 'fetching-electrum' : 'loading' } as const
      return withCirculating({ state: 'chaingraph' as const, reservedFT: tokenInfo.reservedSupplyFT })
    }
    if (electrumVerification.error) {
      return withCirculating({ state: 'unverified' as const, reservedFT: tokenInfo.reservedSupplyFT })
    }
    return withCirculating({
      state: 'verified' as const,
      reservedFT: electrumVerification.electrumReservedFT,
      exactMatch: electrumVerification.electrumReservedFT === tokenInfo.reservedSupplyFT
    })
  })()
  const supplyFigures = supply && 'naiveCirculating' in supply ? supply : null
  // From the (slower, Chaingraph-only) sum of all unspent outputs: burned = genesis minus everything
  // still unspent, split below into tokens sent to a burn output and tokens no longer in any output
  // (spent but not passed on). Less reliable than the naive figures when Chaingraph is stale.
  // Held (user + contract) + burned + reserved = genesis.
  const removedFT = extendedInfo && hasFT ? tokenInfo.genesisSupplyFT - extendedInfo.totalSupplyFT : undefined
  const circulatingExclBurns = extendedInfo && hasFT ? extendedInfo.totalSupplyFT - tokenInfo.reservedSupplyFT : undefined
  const removal = supplyRemovalRows(removedFT, knownBurns?.burnedFT)

  const reservedUtxos = tokenInfo.reservedSupplyUtxos.filter(utxo => utxo.isAuthhead || utxo.fungibleTokenAmount > 0n)
  const covenantUtxos = reservedUtxos.filter(utxo => !utxo.isAuthhead && !utxo.lockingBytecode.startsWith('76a914'))
  const p2pkhUtxos = reservedUtxos.filter(utxo => !utxo.isAuthhead && utxo.lockingBytecode.startsWith('76a914'))
  const authheadUtxo = reservedUtxos.find(utxo => utxo.isAuthhead)
  const reservedSummaryParts: string[] = []
  if (covenantUtxos.length > 0) reservedSummaryParts.push(`${covenantUtxos.length} issuing covenant UTXO${covenantUtxos.length > 1 ? 's' : ''}`)
  if (p2pkhUtxos.length > 0) reservedSummaryParts.push(`${p2pkhUtxos.length} P2PKH UTXO${p2pkhUtxos.length > 1 ? 's' : ''}`)
  if (authheadUtxo) reservedSummaryParts.push('identity output')

  // Only relevant as a comparison against Electrum figures — when verification is off,
  // the headline "Reserved supply" already shows the same Chaingraph number.
  const showElectrumChaingraphReserved = !tokenInfo.issuingUtxosError && !!extendedInfo && !!metadataInfo?.tokenMetadata && hasFT &&
    (electrumEnabled || !!electrumVerification) &&
    !(!!electrumVerification && !electrumVerification.error && electrumVerification.electrumReservedFT === tokenInfo.reservedSupplyFT)

  const mintingCount = tokenInfo.reservedSupplyUtxos.filter(utxo => utxo.nftCapability === 'minting').length
  const showNftState = !!extendedInfo && extendedInfo.totalSupplyNFTs > 0 && !tokenInfo.issuingUtxosError

  return (
    <div className={`card ${styles.section}`}>
      <SectionTitle>Supply</SectionTitle>

      {(tokenInfo.genesisInfoError || tokenInfo.issuingUtxosError || tokenInfo.burnsError) && (
        <div className="note note-warn" style={{ marginBottom: '16px' }}>
          {tokenInfo.genesisInfoError && <div>{tokenInfo.genesisInfoError} — genesis supply and NFT presence can&apos;t be shown.</div>}
          {tokenInfo.issuingUtxosError && <div>{tokenInfo.issuingUtxosError} — reserved supply can&apos;t be shown.</div>}
          {tokenInfo.burnsError && <div>{tokenInfo.burnsError} — burned supply can&apos;t be split into burn outputs and other removals.</div>}
        </div>
      )}

      {/* Headline supply figures */}
      {(hasFT || (extendedInfo && extendedInfo.totalSupplyNFTs > 0)) && (
        <StatGrid>
          {hasFT && (
            <Stat label="Genesis supply" value={displayTokenAmount(tokenInfo.genesisSupplyFT)} />
          )}

          {supplyFigures && supplyFigures.reservedFT > 0n && (
            <>
              <Stat label="Circulating supply (naive)" value={displayTokenAmount(supplyFigures.naiveCirculating)} />
              <Stat label="Reserved supply" value={displayTokenAmount(supplyFigures.reservedFT)} sub={supplyFigures.state === 'unverified' ? '(unverified)' : undefined} />
            </>
          )}
          {(supply?.state === 'loading' || supply?.state === 'fetching-electrum') && (
            <Stat label="Circulating supply" value={<span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.9rem' }}>{supply.state === 'loading' ? 'loading…' : 'verifying via Electrum…'}</span>} />
          )}

          {removedFT !== undefined && removedFT > 0n && (
            <Stat
              label={<>Burned<InfoTip label="About burned supply">
                Genesis supply minus all tokens still in unspent outputs. Split below under Removed from supply into tokens sent to a burn output and tokens no longer in any output.
              </InfoTip></>}
              value={displayTokenAmount(removedFT)}
            />
          )}
          {circulatingExclBurns !== undefined && (
            <Stat label="Circulating (excl. burns)" value={displayTokenAmount(circulatingExclBurns)} />
          )}

          {extendedInfo && extendedInfo.totalSupplyNFTs > 0 && (
            <Stat
              label="Total NFTs"
              value={extendedInfo.totalSupplyNFTs.toLocaleString("en-GB")}
              sub={!tokenInfo.issuingUtxosError && mintingCount > 0 ? `incl. ${mintingCount} minting` : undefined}
            />
          )}
        </StatGrid>
      )}

      {/* Verification note for the primary supply figures */}
      {supply?.state === 'verified' && (
        <div style={{ marginTop: '14px' }}>
          {supply.exactMatch ? (
            <div className="note note-success">Supply verified via Electrum.</div>
          ) : (
            <div className="note note-info">Used Electrum to select the accurate UTXOs from Chaingraph (Chaingraph reported some stale reserves).</div>
          )}
        </div>
      )}
      {/* A fact, not a verdict: tokens can still have been removed from supply */}
      {supplyFigures && supplyFigures.reservedFT === 0n && (
        <div className="note note-muted" style={{ marginTop: '14px' }}>No reserved supply.</div>
      )}

      {/* Reserved-supply UTXO breakdown */}
      {supplyFigures && reservedSummaryParts.length > 0 && (
        <details className="disclosure" style={{ marginTop: '14px' }}>
          <summary>Reserved supply held on {reservedSummaryParts.join(' and ')}</summary>
          <div className="disclosure-body">
            <div style={{ marginTop: '10px' }}>
              {reservedUtxos.map(utxo => (
                <UtxoEntry key={`${utxo.txHash}:${utxo.vout}`} utxo={utxo} network={tokenInfo.network} displayTokenAmount={displayTokenAmount} />
              ))}
            </div>
          </div>
        </details>
      )}

      {/* NFT parse metadata */}
      {nfts && Object.keys(nfts.parse.types).length > 0 && (
        <div style={{ marginTop: '14px' }}>
          <NftParseDetails nfts={nfts} />
        </div>
      )}

      {/* Detailed supply + holders */}
      {(metadataInfo?.httpsUrl || extendedInfo || showElectrumChaingraphReserved || hasKnownBurns) && (
        <>
          <div className={styles.sectionTitle} style={{ marginTop: '24px' }}>Holders &amp; detailed supply</div>

          {extendedInfo && (electrumEnabled || electrumVerification) && (
            <div style={{ marginBottom: '14px' }}>
              {electrumVerification ? (
                <ElectrumVerificationBadge verification={electrumVerification} />
              ) : (
                <div className="note note-muted">Fetching supply info from Electrum…</div>
              )}
            </div>
          )}

          {showElectrumChaingraphReserved && (
            <div style={{ marginBottom: '14px' }}>
              <Rows>
                <Row label="Reserved supply (Chaingraph)">{displayTokenAmount(tokenInfo.reservedSupplyFT)}</Row>
              </Rows>
            </div>
          )}

          {/* Holders, then where the held supply sits */}
          {metadataInfo?.httpsUrl && (
            extendedInfo ? (
              <StatGrid>
                <Stat label={`User addresses holding ${symbol || 'token'}`} value={extendedInfo.numberHolders.toLocaleString("en-GB")} />
                <Stat label="Smart contract addresses" value={(extendedInfo.numberTokenAddresses - extendedInfo.numberHolders).toLocaleString("en-GB")} />
                <Stat label="Total holding addresses" value={extendedInfo.numberTokenAddresses.toLocaleString("en-GB")} />
                {hasFT && extendedInfo.userSupplyFT > 0n && (
                  <Stat label="Held on user addresses" value={displayTokenAmount(extendedInfo.userSupplyFT)} />
                )}
                {hasFT && extendedInfo.contractSupplyFT > 0n && (
                  <Stat label="Held in smart contracts" value={displayTokenAmount(extendedInfo.contractSupplyFT)} />
                )}
              </StatGrid>
            ) : extendedInfoError ? (
              <div className="note note-danger">{extendedInfoError}</div>
            ) : (
              <div className="note note-muted">Loading holder data…</div>
            )
          )}

          {/* NFTs: minting state and the minting/mutable UTXOs */}
          {showNftState && (
            <>
              <div className={styles.sectionTitle} style={{ marginTop: '24px' }}>NFTs</div>
              <Rows>
                <Row label="Has active minting NFT">{tokenInfo.hasActiveMintingToken ? 'yes' : 'no'}</Row>
              </Rows>
              {tokenInfo.reservedSupplyUtxos.length > 0 && (
                <details className="disclosure" style={{ marginTop: '14px' }}>
                  <summary>Minting &amp; mutable NFT UTXOs ({tokenInfo.reservedSupplyUtxos.length})</summary>
                  <div className="disclosure-body">
                    <div style={{ marginTop: '10px' }}>
                      {tokenInfo.reservedSupplyUtxos.map(utxo => (
                        <UtxoEntry key={`${utxo.txHash}:${utxo.vout}`} utxo={utxo} network={tokenInfo.network} displayTokenAmount={displayTokenAmount} />
                      ))}
                    </div>
                  </div>
                </details>
              )}
            </>
          )}

          {/* Removed from supply: FT rows (with held and reserved above, these reconcile to genesis),
              burned NFTs, then the burn transactions behind both */}
          {(removal.rows.length > 0 || removal.inconsistent || hasKnownBurns) && (
            <>
              <div className={styles.sectionTitle} style={{ marginTop: '24px' }}>Removed from supply</div>
              {(removal.rows.length > 0 || (knownBurns && knownBurns.burnedNFTs > 0)) && (
                <Rows>
                  {removal.rows.map(row => {
                    const { label, tipLabel, tip } = REMOVAL_LABEL[row.kind]
                    return (
                      <Row key={row.kind} label={<>{label}<InfoTip label={tipLabel}>{tip}</InfoTip></>}>
                        {displayTokenAmount(row.amount)}
                      </Row>
                    )
                  })}
                  {knownBurns && knownBurns.burnedNFTs > 0 && (
                    <Row label={<>NFTs sent to a burn output<InfoTip label="About burned NFTs">
                      In lending protocols this usually means a loan was closed.
                    </InfoTip></>}>{knownBurns.burnedNFTs.toLocaleString("en-GB")}</Row>
                  )}
                </Rows>
              )}
              {removal.inconsistent && (
                <div className="note note-warn" style={{ marginTop: '10px' }}>
                  Chaingraph data inconsistent: unspent supply exceeds genesis supply minus burns, so removed supply can&apos;t be derived from it.
                </div>
              )}
              {knownBurns && knownBurns.burns.length > 0 && (
                <div style={{ marginTop: '14px' }}>
                  {/* keyed by token, so "Show more" resets on a new search */}
                  <BurnTransactionList key={tokenInfo.genesisTx} burns={knownBurns.burns} displayTokenAmount={displayTokenAmount} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
