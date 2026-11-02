import Head from 'next/head'
import styles from '@/styles/Home.module.css'
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth'
import React, { useEffect, useRef, useState } from 'react'
import { queryGenesisInfo, queryIssuingUtxos, queryAuthchain, queryAllTokenHolders, queryGenesisCategories, parseAuthchainMigrations, type AuthchainQueryResult } from '../utils/queryChainGraph'
import { countUniqueHolders, calculateTotalSupplyFT } from '../utils/calculations'
import { checkOtrVerified } from '../utils/otrRegistry'
import { sanitizeTokenId, ipfsToGatewayUrl } from '../utils/utils'
import { isBcmrOutput, resolveRegistry, selectLatestPublication, type RegistryResolution } from '../utils/bcmr'
import type { TokenInfo, ExtendedTokenInfo, MetadataInfo, ReservedSupplyUtxo, ElectrumVerification } from '@/interfaces'
import { EXAMPLE_TOKENS } from '@/constants'
import { verifySupplyViaElectrum } from '@/utils/queryElectrum'
import { TokenSearch, MetadataDisplay, SupplyStats, AuthchainInfo, ThemeToggle } from '@/components'

const QUERY_TIMEOUT_MS = 20_000
const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS)
    )
  ])

export default function Home() {
  const [tokenId, setTokenId] = useState<string>("")
  const [isLoadingTokenInfo, setIsLoadingTokenInfo] = useState<boolean>(false)
  const [tokenInfo, setTokenInfo] = useState<TokenInfo>()
  const [extendedTokenInfo, setExtendedTokenInfo] = useState<ExtendedTokenInfo>()
  const [tokenInfoError, setTokenInfoError] = useState<string>()
  const [extendedTokenInfoError, setExtendedTokenInfoError] = useState<string>()
  const [metadataInfo, setMetadataInfo] = useState<MetadataInfo>()
  const [tokenIconUri, setTokenIconUri] = useState<string>("")
  const [electrumVerification, setElectrumVerification] = useState<ElectrumVerification>()
  const [verifyElectrum, setVerifyElectrum] = useState<boolean>(false)

  // Mirrors verifyElectrum for async code (Phase 3 runs long after the closure was created)
  const verifyElectrumRef = useRef(false)
  // Phase-3 arguments, kept so enabling the toggle mid-view can still verify the loaded token
  const electrumArgsRef = useRef<Parameters<typeof verifySupplyViaElectrum> | null>(null)
  // Search generation of the Electrum run in flight (null when idle), so a run for an
  // older search neither blocks nor overwrites verification of the current token
  const electrumInFlightRef = useRef<number | null>(null)
  // Incremented on every new search and on reset; async work from an older search
  // compares against it and drops its results instead of overwriting the current view
  const searchGenerationRef = useRef(0)

  useEffect(() => {
    const stored = localStorage.getItem('verifyElectrum') === 'true'
    setVerifyElectrum(stored)
    verifyElectrumRef.current = stored
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    const params = new URLSearchParams(url.search)
    const readTokenId = sanitizeTokenId(params.get("tokenId") ?? "")
    // The pre-paint script (see _document) sets data-has-token so the hero renders
    // compact before first paint; React now owns the UI, so clear it.
    document.documentElement.removeAttribute("data-has-token")
    if (!readTokenId) return
    searchToken(readTokenId)
  }, [])

  useEffect(() => {
    const imageOrIconUri = metadataInfo?.tokenMetadata?.uris?.image ?? metadataInfo?.tokenMetadata?.uris?.icon
    if (imageOrIconUri) {
      setTokenIconUri(ipfsToGatewayUrl(imageOrIconUri))
    }
  }, [metadataInfo])

  useEffect(() => {
    if (tokenInfo) {
      setIsLoadingTokenInfo(false)
    }
  }, [tokenInfo])

  // Resolves when metadata has been set, so lookUpTokenData can wait briefly for it
  const metadataReadyRef = useRef<{ resolve: () => void } | null>(null)

  function searchToken(rawId: string) {
    const id = sanitizeTokenId(rawId)
    const generation = ++searchGenerationRef.current
    const isCurrent = () => searchGenerationRef.current === generation
    setTokenId(id)
    setTokenInfo(undefined)
    setTokenInfoError(undefined)
    setExtendedTokenInfo(undefined)
    setExtendedTokenInfoError(undefined)
    setMetadataInfo(undefined)
    setTokenIconUri("")
    setElectrumVerification(undefined)
    electrumArgsRef.current = null
    setIsLoadingTokenInfo(true)
    const metadataReadyPromise = new Promise<void>(resolve => {
      metadataReadyRef.current = { resolve }
    })
    // One authchain query feeds both the token info and the BCMR metadata resolution
    const authchainPromise = withTimeout(queryAuthchain(id), 'queryAuthchain')
    lookUpTokenData(id, authchainPromise, metadataReadyPromise, isCurrent)
    fetchMetadata(id, authchainPromise, isCurrent)
    checkOtrStatus(id, isCurrent)
    const params = new URLSearchParams(window.location.search)
    params.set("tokenId", id)
    window.history.replaceState({}, "", `${location.pathname}?${params}`)
  }

  function resetToHome() {
    searchGenerationRef.current++
    setTokenId("")
    setTokenInfo(undefined)
    setTokenInfoError(undefined)
    setExtendedTokenInfo(undefined)
    setExtendedTokenInfoError(undefined)
    setMetadataInfo(undefined)
    setTokenIconUri("")
    setElectrumVerification(undefined)
    electrumArgsRef.current = null
    setIsLoadingTokenInfo(false)
    window.history.replaceState({}, "", location.pathname)
  }

  function runElectrumVerification() {
    const args = electrumArgsRef.current
    // electrumArgsRef only ever holds the current search's arguments
    const generation = searchGenerationRef.current
    if (!args || electrumInFlightRef.current === generation) return
    electrumInFlightRef.current = generation
    const isCurrent = () => searchGenerationRef.current === generation
    verifySupplyViaElectrum(...args).then(
      result => {
        if (isCurrent() && verifyElectrumRef.current) setElectrumVerification(result)
      },
      error => {
        console.error("Electrum verification failed:", error)
        if (!isCurrent() || !verifyElectrumRef.current) return
        setElectrumVerification({
          verified: false,
          totalChaingraphUtxos: args[0].length,
          totalElectrumUtxos: 0,
          staleCount: 0,
          missingCount: 0,
          chaingraphTotalFT: 0n,
          electrumTotalFT: 0n,
          electrumReservedFT: 0n,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    ).finally(() => {
      if (electrumInFlightRef.current === generation) electrumInFlightRef.current = null
    })
  }

  function toggleVerifyElectrum(enabled: boolean) {
    setVerifyElectrum(enabled)
    verifyElectrumRef.current = enabled
    localStorage.setItem('verifyElectrum', String(enabled))
    if (enabled) {
      if (!electrumVerification) runElectrumVerification()
    } else {
      setElectrumVerification(undefined)
    }
  }

  async function checkOtrStatus(tokenId: string, isCurrent: () => boolean) {
    const isOtrVerified = await checkOtrVerified(tokenId)
    if (!isCurrent()) return
    setMetadataInfo(prev => prev ? { ...prev, isOtrVerified } : { isOtrVerified })
  }

  async function fetchMetadata(tokenId: string, authchainPromise: Promise<AuthchainQueryResult>, isCurrent: () => boolean) {
    let metaDataLocation = ""
    let httpsUrl: string | undefined
    let authchainUpdates = 0
    let resolution: RegistryResolution = { diagnostics: [] }

    try {
      const migrations = parseAuthchainMigrations(await authchainPromise)
      const { metadataUpdates, publication, diagnostic } = selectLatestPublication(migrations, tokenId)
      authchainUpdates = metadataUpdates
      if (publication) {
        httpsUrl = publication.httpsUrl
        metaDataLocation = publication.resolvedUri
        resolution = await resolveRegistry(publication, tokenId)
      } else if (diagnostic) {
        resolution.diagnostics.push(diagnostic)
      }
    } catch (error) {
      console.log(error)
    }

    // A newer search has replaced metadataReadyRef too, so don't resolve it either
    if (!isCurrent()) return
    const { tokenMetadata, metadataHashMatch, isSchemaValid, diagnostics } = resolution
    setMetadataInfo(prev => ({
      ...prev,
      metaDataLocation,
      tokenMetadata,
      httpsUrl,
      authchainUpdates,
      metadataHashMatch,
      isSchemaValid,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined
    }))
    metadataReadyRef.current?.resolve()
  }

  async function lookUpTokenData(
    tokenId: string,
    authchainPromise: Promise<AuthchainQueryResult>,
    metadataReady: Promise<void>,
    isCurrent: () => boolean
  ) {
    // Start holder query early so it runs in parallel, but await it in Phase 2
    const holderDataPromise = queryAllTokenHolders(tokenId)
    let network: 'mainnet' | 'chipnet' = 'mainnet'
    let authHead = ''
    let authHeadVout = 0
    let authHeadAddress: string | undefined
    let authHeadBurned = false

    try {
      // Start all queries in parallel, but don't block on the slow holder query
      console.time('initialDataLoad')

      const [genesisResult, issuingResult, authchainResult] = await Promise.allSettled([
        withTimeout(queryGenesisInfo(tokenId), 'queryGenesisInfo'),
        withTimeout(queryIssuingUtxos(tokenId), 'queryIssuingUtxos'),
        authchainPromise
      ])

      if (!isCurrent()) return
      const respJsonAuthchain = authchainResult.status === 'fulfilled' ? authchainResult.value : null
      if (!respJsonAuthchain) {
        const reason = authchainResult.status === 'rejected' ? authchainResult.reason : 'query returned null'
        console.error("Error fetching authchain from Chaingraph:", reason)
        setTokenInfoError("Failed to load core token data from Chaingraph")
        setIsLoadingTokenInfo(false)
        return
      }

      const respJsonGenesisSupply = genesisResult.status === 'fulfilled' ? genesisResult.value : null
      const respJsonIssuingUtxos = issuingResult.status === 'fulfilled' ? issuingResult.value : null
      const genesisInfoError = !respJsonGenesisSupply ? "Failed to load genesis info from Chaingraph" : undefined
      const issuingUtxosError = !respJsonIssuingUtxos ? "Failed to load reserved supply data from Chaingraph" : undefined
      if (genesisInfoError) {
        console.error(genesisInfoError, genesisResult.status === 'rejected' ? genesisResult.reason : '(query returned null)')
      }
      if (issuingUtxosError) {
        console.error(issuingUtxosError, issuingResult.status === 'rejected' ? issuingResult.reason : '(query returned null)')
      }

      // Check if the transaction exists on-chain (authchain query finds it by hash)
      const validTxId = respJsonAuthchain.transaction.length > 0

      // Parse genesis supply (only if the query succeeded; fall back to tokenId for genesisTx)
      const genesisTransaction = respJsonGenesisSupply?.transaction[0]
      const genesisTx = genesisTransaction?.hash?.substring(2) ?? tokenId
      const blockTimestamp = genesisTransaction?.block_inclusions?.[0]?.block?.timestamp
      const genesisTxTimestamp = blockTimestamp ? Number(blockTimestamp) : undefined
      const nodeName = respJsonAuthchain.transaction[0]?.block_inclusions?.[0]?.block?.accepted_by?.[0]?.node?.name
      network = nodeName?.includes('chipnet') ? 'chipnet' : 'mainnet'

      let genesisSupplyFT = 0n
      let hasGenesisNFTs = false
      if (genesisTransaction?.outputs) {
        genesisSupplyFT = genesisTransaction.outputs.reduce(
          (total: bigint, output) => total + BigInt(output?.fungible_token_amount ?? '0'),
          0n
        )
        hasGenesisNFTs = genesisTransaction.outputs.some(
          output => output.nonfungible_token_capability != null
        )
      }

      // Parse reserved supply UTXOs (minting + mutable NFT UTXOs) — only if the query succeeded
      const reservedSupplyUtxos: ReservedSupplyUtxo[] = respJsonIssuingUtxos
        ? respJsonIssuingUtxos.output.map(o => ({
            txHash: (o.transaction_hash as string).slice(2),
            vout: Number(o.output_index),
            lockingBytecode: (o.locking_bytecode as string).slice(2),
            fungibleTokenAmount: BigInt(o.fungible_token_amount ?? "0"),
            nftCapability: o.nonfungible_token_capability as 'minting' | 'mutable'
          }))
        : []
      const hasActiveMintingToken = reservedSupplyUtxos.some(utxo => utxo.nftCapability === "minting")
      const covenantReservedFT = reservedSupplyUtxos.reduce(
        (total: bigint, u) => total + u.fungibleTokenAmount, 0n
      )

      // Parse authchain data with intermediate variables
      const authchainData = respJsonAuthchain.transaction[0]?.authchains?.[0]
      const authheadData = authchainData?.authhead
      const identityOutput = authheadData?.identity_output?.[0]

      const authchainLength = authchainData?.authchain_length ?? 0
      authHead = authheadData?.hash?.slice(2) ?? ''

      const authheadReservedFT = BigInt(identityOutput?.fungible_token_amount ?? 0)
      const authHeadLockingBytecode = identityOutput?.locking_bytecode as string | undefined

      // Check if the authhead's identity output (output 0) is an OP_RETURN.
      // If so, the authchain is burned — it can never be extended since OP_RETURN is unspendable.
      const identityBytecodeHex = identityOutput?.locking_bytecode?.slice(2) ?? ''
      authHeadBurned = identityBytecodeHex.startsWith('6a')

      // Parse authhead timestamp and check if it's a metadata update
      const authHeadBlockTimestamp = authheadData?.block_inclusions?.[0]?.block?.timestamp
      const authHeadTimestamp = authHeadBlockTimestamp ? Number(authHeadBlockTimestamp) : undefined
      const authHeadOutputs = authheadData?.outputs as Array<{ output_index: number, locking_bytecode: string }> | undefined
      const authHeadIsMetadataUpdate = authHeadOutputs?.some(
        output => isBcmrOutput(output.locking_bytecode?.slice(2) ?? '')
      ) ?? false

      let usesAuthGuard = false
      if (authHeadLockingBytecode) {
        const bytecodeHex = authHeadLockingBytecode.slice(2)
        usesAuthGuard = bytecodeHex.startsWith('a914')
        const authHeadAddressResult = lockingBytecodeToCashAddress({
          bytecode: hexToBin(bytecodeHex),
          prefix: network === 'chipnet' ? 'bchtest' : 'bitcoincash'
        })
        authHeadAddress = typeof authHeadAddressResult === 'string' ? undefined : authHeadAddressResult.address
      }

      const authchainMigrations = parseAuthchainMigrations(respJsonAuthchain)
      // Remove pre-genesis migrations (Chaingraph includes the funding tx)
      const genesisIndex = authchainMigrations.findIndex(m => m.txHash === genesisTx)
      const filteredMigrations = genesisIndex >= 0 ? authchainMigrations.slice(genesisIndex) : authchainMigrations

      // Phase 1: set initial tokenInfo from fast queries
      console.timeEnd('initialDataLoad')
      // If genesis info is unavailable we can't determine FT/NFT presence; trust validTxId instead
      const validTokenCategory = respJsonGenesisSupply ? (genesisSupplyFT > 0n || hasGenesisNFTs) : validTxId

      // If not a valid token category, check if this tx is a genesis tx for other categories
      let tokenCategoriesInTx: string[] | undefined
      if (!validTokenCategory && validTxId) {
        const respTokenOutputs = await queryGenesisCategories(tokenId)
        if (respTokenOutputs?.transaction?.[0]) {
          const tx = respTokenOutputs.transaction[0]
          const input0Hash = tx.inputs?.[0]?.outpoint_transaction_hash
          if (input0Hash) {
            const genesisCategories = new Set<string>()
            for (const output of tx.outputs ?? []) {
              if (output.token_category === input0Hash) {
                genesisCategories.add(output.token_category.slice(2))
              }
            }
            if (genesisCategories.size > 0) {
              tokenCategoriesInTx = [...genesisCategories]
            }
          }
        }
      }

      // Wait up to 200ms for metadata to arrive, to avoid a flash of content without metadata
      await Promise.race([
        metadataReady,
        new Promise(resolve => setTimeout(resolve, 200))
      ])
      if (!isCurrent()) return

      // Add authhead identity output to reserved supply UTXOs if it holds FT
      authHeadVout = Number(identityOutput?.output_index ?? 0)
      const authHeadAlreadyIncluded = reservedSupplyUtxos.some(
        u => u.txHash === authHead && u.vout === authHeadVout
      )
      if (authHeadAlreadyIncluded) {
        // Mark the existing entry as authhead
        const existing = reservedSupplyUtxos.find(utxo => utxo.txHash === authHead && utxo.vout === authHeadVout)
        if (existing) existing.isAuthhead = true
      } else if (authheadReservedFT > 0n && authHeadLockingBytecode) {
        reservedSupplyUtxos.push({
          txHash: authHead,
          vout: authHeadVout,
          lockingBytecode: authHeadLockingBytecode.slice(2),
          fungibleTokenAmount: authheadReservedFT,
          nftCapability: identityOutput?.nonfungible_token_capability as 'minting' | 'mutable' | null ?? null,
          isAuthhead: true
        })
      }

      const reservedSupplyFT = covenantReservedFT + (authHeadAlreadyIncluded ? 0n : authheadReservedFT)

      setTokenInfo({
        validTxId,
        validTokenCategory,
        tokenCategoriesInTx,
        hasGenesisNFTs,
        genesisSupplyFT,
        hasActiveMintingToken,
        reservedSupplyUtxos,
        reservedSupplyFT,
        genesisTx,
        genesisTxTimestamp,
        authchainLength,
        authHead,
        authHeadAddress,
        authHeadTimestamp,
        authHeadIsMetadataUpdate,
        authHeadBurned,
        usesAuthGuard,
        network,
        authchainMigrations: filteredMigrations,
        genesisInfoError,
        issuingUtxosError
      })
    } catch (error) {
      console.error("Error in initial data load:", error)
      if (!isCurrent()) return
      setTokenInfoError("Failed to load token data from Chaingraph")
      setIsLoadingTokenInfo(false)
      return
    }

    // Phase 2: await holder data (already started in parallel)
    try {
      console.time('queryAllTokenHolders')
      const respJsonAllTokenHolders = await holderDataPromise
      console.timeEnd('queryAllTokenHolders')
      if (!isCurrent()) return
      if (!respJsonAllTokenHolders) {
        setExtendedTokenInfoError("Failed to load holder & supply data")
        return
      }

      // Paginate queryAllTokenHolders (returns max 5000 per page)
      let allTokenOutputs = respJsonAllTokenHolders.output
      let lastBatchSize = allTokenOutputs.length
      let indexOffset = 0

      while (lastBatchSize === 5000) {
        indexOffset += 1
        console.time(`queryAllTokenHolders page ${indexOffset + 1}`)
        const nextPage = await queryAllTokenHolders(tokenId, 5000 * indexOffset)
        console.timeEnd(`queryAllTokenHolders page ${indexOffset + 1}`)
        if (!isCurrent()) return
        if (!nextPage) {
          setExtendedTokenInfoError("Failed to load holder & supply data (pagination error)")
          return
        }
        allTokenOutputs = allTokenOutputs.concat(nextPage.output)
        lastBatchSize = nextPage.output.length
      }

      // Calculate totalSupplyNFTs
      const totalSupplyNFTs = allTokenOutputs.filter(
        (o: { nonfungible_token_capability: string | null }) => o.nonfungible_token_capability !== null
      ).length

      // Calculate supply stats
      const totalSupplyFT = calculateTotalSupplyFT(allTokenOutputs)

      // Calculate holder stats
      const { numberHolders, numberTokenAddresses, userSupplyFT, contractSupplyFT } = countUniqueHolders(allTokenOutputs)

      // Set extended token info (supply & holder data)
      setExtendedTokenInfo({
        totalSupplyFT,
        totalSupplyNFTs,
        numberHolders,
        numberTokenAddresses,
        userSupplyFT,
        contractSupplyFT,
      })

      // Phase 3: Verify supply via Electrum (opt-in via footer toggle, background, non-blocking)
      // Don't pass authHead for Electrum check if the authhead is burned (OP_RETURN identity output)
      const authHeadForElectrum = (authHead && !authHeadBurned) ? { txHash: authHead, vout: authHeadVout, address: authHeadAddress } : undefined
      electrumArgsRef.current = [allTokenOutputs, tokenId, network, authHeadForElectrum]
      if (verifyElectrumRef.current) runElectrumVerification()
    } catch (error) {
      console.error("Error in queryAllTokenHolders:", error)
      if (!isCurrent()) return
      setExtendedTokenInfoError("Failed to load holder & supply data")
    }
  }

  const getTokenType = () => {
    if (!tokenInfo) return ''
    if (tokenInfo.genesisSupplyFT && !tokenInfo.hasGenesisNFTs) return 'Fungible Token'
    if (!tokenInfo.genesisSupplyFT && tokenInfo.hasGenesisNFTs) return 'NFT collection'
    if (tokenInfo.genesisSupplyFT && tokenInfo.hasGenesisNFTs) return 'Fungible + Non-Fungible'
    return 'CashToken'
  }

  const showResults = tokenInfo && tokenInfo.validTokenCategory
  const compact = !!tokenInfo || isLoadingTokenInfo

  return (
    <>
      <Head>
        <title>CashToken Explorer</title>
        <meta name="description" content="Explore CashTokens metadata, supply, holders and authchain on Bitcoin Cash" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </Head>
      <main className={styles.page}>
        <ThemeToggle />
        <header className={`${styles.hero} app-hero ${compact ? styles.heroCompact : ''}`}>
          <button
            type="button"
            className={styles.brand}
            onClick={resetToHome}
            aria-label="Back to home"
          >
            <span className={styles.brandMark}>₿</span>
            <h1 className={`${styles.title} app-title ${compact ? styles.titleCompact : ''}`}>CashToken Explorer</h1>
          </button>
          {!compact && (
            <p className={`${styles.subtitle} app-landing-only`}>
              Explore CashTokens metadata, supply, holders and authchain on Bitcoin Cash.
            </p>
          )}
          <TokenSearch
            tokenId={tokenId}
            isLoading={isLoadingTokenInfo}
            hasTokenInfo={!!tokenInfo}
            onTokenIdChange={setTokenId}
            onSearch={() => searchToken(tokenId)}
          />
          {!compact && (
            <>
              <div className={`${styles.searchHint} app-landing-only`}>
                Paste a Token ID (Category ID) to look it up — or try an example below.
              </div>
              <div className={`${styles.examples} app-landing-only`}>
                <div className={styles.examplesLabel}>Example tokens</div>
                <div className={styles.exampleList}>
                  {EXAMPLE_TOKENS.map(example => (
                    <button
                      key={example.id}
                      className={styles.exampleItem}
                      onClick={() => searchToken(example.id)}
                    >
                      <span className={styles.exampleName}>{example.name}</span>
                      <span className={styles.exampleId}>{example.id}</span>
                      <svg className={styles.exampleArrow} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </header>

        <div className={styles.content}>
          {tokenInfoError && (
            <div className="note note-danger">{tokenInfoError}</div>
          )}

          {tokenInfo && !tokenInfo.validTxId && (
            <div className="note note-info">
              This is not a valid CashTokens tokenId. No transaction with this hash was found on the blockchain.
            </div>
          )}

          {tokenInfo && tokenInfo.validTxId && tokenInfo.validTokenCategory === false && (
            <div className="note note-info">
              This is not a valid CashTokens tokenId. The transaction exists on-chain but no tokens were created with this ID.
              {tokenInfo.tokenCategoriesInTx && tokenInfo.tokenCategoriesInTx.length > 0 && (
                <div style={{ marginTop: "8px" }}>
                  This is a genesis transaction for the following tokenId{tokenInfo.tokenCategoriesInTx.length > 1 ? 's' : ''}:
                  {tokenInfo.tokenCategoriesInTx.map(cat => (
                    <div key={cat} style={{ marginTop: "4px" }}>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          searchToken(cat)
                        }}
                        className="mono"
                        style={{ wordBreak: "break-all" }}
                      >
                        {cat}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {showResults && (
            <>
              <MetadataDisplay
                metadataInfo={metadataInfo}
                tokenIconUri={tokenIconUri}
                tokenType={getTokenType()}
                network={tokenInfo.network}
              />
              <SupplyStats
                tokenInfo={tokenInfo}
                extendedInfo={extendedTokenInfo}
                extendedInfoError={extendedTokenInfoError}
                metadataInfo={metadataInfo}
                electrumVerification={electrumVerification}
                electrumEnabled={verifyElectrum}
              />
              <AuthchainInfo
                tokenInfo={tokenInfo}
                metadataInfo={metadataInfo}
                electrumVerification={electrumVerification}
              />
            </>
          )}
        </div>

        {showResults && (
          <div className={styles.footerLinks}>
            {tokenInfo.network === 'mainnet' && (
              <span>
                Cross-check with{" "}
                <a href={`https://explorer.salemkode.com/token/${tokenId}`} target="_blank" rel="noopener noreferrer">
                  SalemKode explorer
                </a>
              </span>
            )}
            <span>
              Paytaca BCMR indexer ({tokenInfo.network}):{" "}
              <a
                href={`https://${tokenInfo.network === 'chipnet' ? 'bcmr-chipnet' : 'bcmr'}.paytaca.com/api/tokens/${tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                /tokens endpoint
              </a>
            </span>
            <label className={styles.footerToggle} title="Cross-check Chaingraph UTXO data against an Electrum server. Useful for debugging or when using a Chaingraph instance that may serve stale data.">
              <input
                type="checkbox"
                checked={verifyElectrum}
                onChange={event => toggleVerifyElectrum(event.target.checked)}
              />
              verify supply via Electrum
            </label>
          </div>
        )}
      </main>
    </>
  )
}
