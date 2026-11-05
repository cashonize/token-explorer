import type { TokenInfo, ExtendedTokenInfo, MetadataInfo, NftCategory, ElectrumVerification, ReservedSupplyUtxo, BurnEntry } from '@/interfaces'
import { lockingBytecodeToCashAddress, hexToBin } from '@bitauth/libauth'
import styles from '@/styles/Home.module.css'
import { BLOCK_EXPLORER_URL } from '@/constants'
import { formatTimestamp } from '@/utils/utils'
import { groupBurnsByTransaction } from '@/utils/burns'
import { Badge, HashLink, InfoTip, SectionTitle, Stat, StatGrid, Row, Rows } from './ui'

// Burn transactions listed in the disclosure (latest first); the rest are summarised as "and N more"
const MAX_LISTED_BURN_TXS = 50

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

const BURN_EXPLANATION = 'Tokens sent to a provably unspendable output (an OP_RETURN, or the tokenburner.cash contract) are permanently removed from supply. Many protocols burn tokens on repayment or redemption.'

function BurnTransactionList({ burns, displayTokenAmount }: { burns: BurnEntry[]; displayTokenAmount: (amount: bigint) => string }) {
  const transactions = groupBurnsByTransaction(burns)
  const listed = transactions.slice(0, MAX_LISTED_BURN_TXS)
  return (
    <details className="disclosure">
      <summary>Burn transactions ({transactions.length.toLocaleString("en-GB")})</summary>
      <div className="disclosure-body">
        <div style={{ marginTop: '10px' }}>
          {listed.map(tx => (
            <div key={tx.txHash} className={styles.entry}>
              <div className={styles.entryHead}>
                {tx.methods.map(method => <Badge key={method}>{BURN_METHOD_LABEL[method]}</Badge>)}
                <span style={{ color: 'var(--text-muted)' }}>{tx.timestamp != null ? formatTimestamp(tx.timestamp) : 'unconfirmed'}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>tx:</span>{' '}
                <HashLink hash={tx.txHash} href={BLOCK_EXPLORER_URL + tx.txHash} truncate />
              </div>
              {(tx.fungibleTokenAmount > 0n || tx.nftCount > 0) && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>burned:</span>{' '}
                  {[
                    tx.fungibleTokenAmount > 0n ? displayTokenAmount(tx.fungibleTokenAmount) : null,
                    tx.nftCount > 0 ? `${tx.nftCount} NFT${tx.nftCount === 1 ? '' : 's'}` : null,
                  ].filter(Boolean).join(' + ')}
                </div>
              )}
            </div>
          ))}
          {transactions.length > listed.length && (
            <div style={{ color: 'var(--text-muted)', marginTop: '10px' }}>
              and {(transactions.length - listed.length).toLocaleString("en-GB")} more
            </div>
          )}
        </div>
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

  // Provable burns (OP_RETURN outputs, tokenburner.cash). They're queried regardless of
  // spent state, so unlike reserved supply they can't be thrown off by stale UTXO data.
  const knownBurns = tokenInfo.knownBurns
  const knownBurnedFT = knownBurns?.burnedFT ?? 0n
  // The burn query lands after Phase 1, so circulating supply waits for it rather than flash a pre-burn figure
  const burnsPending = !knownBurns && !tokenInfo.burnsError
  const hasKnownBurns = !!knownBurns && (knownBurns.burnedFT > 0n || knownBurns.burnedNFTs > 0)

  // Resolve reserved supply (Chaingraph, or Electrum-verified) and circulating = genesis − reserved − known burns.
  const supply = (() => {
    if (!showPrimarySupply) return null
    const withCirculating = <T extends { reservedFT: bigint }>(figures: T) =>
      ({ ...figures, circulating: tokenInfo.genesisSupplyFT - figures.reservedFT - knownBurnedFT })
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
  const supplyFigures = supply && 'circulating' in supply ? supply : null
  const loadingValue = (text: string) => <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.9rem' }}>{text}</span>
  // With nothing reserved or burned the circulating figure would just repeat genesis supply.
  // While burns are pending it only shows (as "loading burns…") when there's a reserve, so a
  // token without reserve or burns doesn't get a card that disappears once burns load as 0.
  const showCirculating = !!supplyFigures && (supplyFigures.reservedFT > 0n || knownBurnedFT > 0n || !!tokenInfo.burnsError)

  // Supply removal, from the (slower, Chaingraph-only) sum of all unspent outputs: genesis minus
  // everything still unspent is every token destroyed. Minus the provable burns, the rest was
  // lost in transactions (left out of the outputs, e.g. by a wallet bug), which can't be
  // attributed to an output. Less reliable than the headline figures when Chaingraph is stale.
  const destroyedFT = extendedInfo && hasFT ? tokenInfo.genesisSupplyFT - extendedInfo.totalSupplyFT : undefined
  const lostFT = destroyedFT !== undefined && knownBurns ? destroyedFT - knownBurns.burnedFT : undefined
  // Unspent > genesis, or unspent > genesis − provable burns, means stale or incomplete Chaingraph data
  const utxoSumInconsistent = (destroyedFT !== undefined && destroyedFT < 0n) || (lostFT !== undefined && lostFT < 0n)
  const showSupplyRemoval = hasKnownBurns || (destroyedFT !== undefined && destroyedFT !== 0n)

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
          {tokenInfo.burnsError && <div>{tokenInfo.burnsError} — circulating supply doesn&apos;t subtract burned tokens.</div>}
        </div>
      )}

      {/* Headline supply figures */}
      {(hasFT || (extendedInfo && extendedInfo.totalSupplyNFTs > 0)) && (
        <StatGrid>
          {hasFT && (
            <Stat label="Genesis supply" value={displayTokenAmount(tokenInfo.genesisSupplyFT)} />
          )}

          {supplyFigures && showCirculating && (
            <Stat
              label={<>Circulating supply<InfoTip>
                Genesis supply minus reserved supply and provably burned tokens. Tokens lost in
                transactions (e.g. through wallet bugs) are not subtracted; see Holders &amp; detailed supply.
              </InfoTip></>}
              value={burnsPending ? loadingValue('loading burns…') : displayTokenAmount(supplyFigures.circulating)}
              sub={tokenInfo.burnsError ? '(burns not included)' : undefined}
            />
          )}
          {supplyFigures && supplyFigures.reservedFT > 0n && (
            <Stat label="Reserved supply" value={displayTokenAmount(supplyFigures.reservedFT)} sub={supplyFigures.state === 'unverified' ? '(unverified)' : undefined} />
          )}
          {(supply?.state === 'loading' || supply?.state === 'fetching-electrum') && (
            <Stat label="Circulating supply" value={loadingValue(supply.state === 'loading' ? 'loading…' : 'verifying via Electrum…')} />
          )}

          {knownBurns && knownBurns.burnedFT > 0n && (
            <Stat
              secondary
              label={<>Burned<InfoTip>{BURN_EXPLANATION}</InfoTip></>}
              value={displayTokenAmount(knownBurns.burnedFT)}
            />
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
      {/* Waits for burns when there's no reserve, so its text doesn't change after it appears */}
      {supplyFigures && supplyFigures.reservedFT === 0n && !burnsPending && (
        <div className="note note-success" style={{ marginTop: '14px' }}>
          {knownBurns?.burnedFT === 0n ? 'No reserved supply — the full supply is circulating.' : 'No reserved supply.'}
        </div>
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

          {/* Holders, then how circulating supply is distributed */}
          {metadataInfo?.httpsUrl && (
            extendedInfo ? (
              <StatGrid>
                <Stat label={`User addresses holding ${symbol || 'token'}`} value={extendedInfo.numberHolders.toLocaleString("en-GB")} />
                <Stat label="Smart-contract addresses" value={(extendedInfo.numberTokenAddresses - extendedInfo.numberHolders).toLocaleString("en-GB")} />
                <Stat label="Total holding addresses" value={extendedInfo.numberTokenAddresses.toLocaleString("en-GB")} />
                {hasFT && extendedInfo.userSupplyFT > 0n && (
                  <Stat label="Circulating on user addresses" value={displayTokenAmount(extendedInfo.userSupplyFT)} />
                )}
                {hasFT && extendedInfo.contractSupplyFT > 0n && (
                  <Stat label="Circulating on smart contracts" value={displayTokenAmount(extendedInfo.contractSupplyFT)} />
                )}
              </StatGrid>
            ) : extendedInfoError ? (
              <div className="note note-danger">{extendedInfoError}</div>
            ) : (
              <div className="note note-muted">Loading holder data…</div>
            )
          )}

          {/* NFT minting state + all minting/mutable UTXOs */}
          {showNftState && (
            <div style={{ marginTop: '14px' }}>
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
            </div>
          )}

          {/* Supply removal: destroyed = provably burned + lost in transactions */}
          {showSupplyRemoval && (
            <div style={{ marginTop: '14px' }}>
              <Rows>
                {destroyedFT !== undefined && destroyedFT > 0n && (
                  <Row label={<>Tokens destroyed<InfoTip>
                    Genesis supply minus all unspent token outputs: every token that no longer exists.
                  </InfoTip></>}>{displayTokenAmount(destroyedFT)}</Row>
                )}
                {knownBurns && knownBurns.burnedFT > 0n && (
                  <Row indent={destroyedFT !== undefined && destroyedFT > 0n} label={<>Provably burned<InfoTip>{BURN_EXPLANATION}</InfoTip></>}>
                    {displayTokenAmount(knownBurns.burnedFT)}
                  </Row>
                )}
                {lostFT !== undefined && lostFT > 0n && (
                  <Row indent label={<>Lost in transactions<InfoTip>
                    Tokens left out of a transaction&apos;s outputs, so they stopped existing without a
                    burn output, e.g. through a wallet bug.
                  </InfoTip></>}>{displayTokenAmount(lostFT)}</Row>
                )}
                {knownBurns && knownBurns.burnedNFTs > 0 && (
                  <Row label={<>NFTs burned<InfoTip>
                    NFTs sent to an unspendable output, e.g. the NFT of a closed loan in a DeFi protocol.
                  </InfoTip></>}>{knownBurns.burnedNFTs.toLocaleString("en-GB")}</Row>
                )}
              </Rows>
              {utxoSumInconsistent && (
                <div className="note note-warn" style={{ marginTop: '10px' }}>
                  Chaingraph data inconsistent: unspent supply exceeds genesis supply minus provable burns, so destroyed tokens can&apos;t be derived from it.
                </div>
              )}
              {knownBurns && knownBurns.burns.length > 0 && (
                <div style={{ marginTop: '14px' }}>
                  <BurnTransactionList burns={knownBurns.burns} displayTokenAmount={displayTokenAmount} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
