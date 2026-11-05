import { TOKENBURNER_LOCKING_BYTECODE } from '@/constants'
import type { BurnEntry, KnownBurns } from '@/interfaces'

/**
 * Whether tokens on an output with this locking bytecode (hex, no \x prefix) are provably
 * burned: an OP_RETURN output is unspendable, and the burner contract can only be spent
 * into a single token-less OP_RETURN output. Such outputs are counted as burns, so they
 * must be left out of holdings and reserved supply.
 */
export function isKnownBurnLockingBytecode(lockingBytecodeHex: string): boolean {
  const hex = lockingBytecodeHex.toLowerCase()
  return hex.startsWith('6a') || hex === TOKENBURNER_LOCKING_BYTECODE
}

/** Sum burned FT and NFT outputs, deduplicated by outpoint, latest burn first. */
export function aggregateBurns(entries: BurnEntry[]): KnownBurns {
  const byOutpoint = new Map<string, BurnEntry>()
  for (const entry of entries) byOutpoint.set(`${entry.txHash}:${entry.vout}`, entry)
  const burns = [...byOutpoint.values()].sort((a, b) =>
    // unconfirmed (no timestamp) first, then newest block first; outpoint order breaks ties
    (b.timestamp ?? Infinity) - (a.timestamp ?? Infinity) ||
    a.txHash.localeCompare(b.txHash) ||
    a.vout - b.vout
  )
  let burnedFT = 0n
  let burnedNFTs = 0
  for (const burn of burns) {
    burnedFT += burn.fungibleTokenAmount
    if (burn.nftCapability !== null) burnedNFTs++
  }
  return { burnedFT, burnedNFTs, burns }
}

export type SupplyRemovalRow =
  | { kind: 'removed', amount: bigint }
  | { kind: 'burned' | 'withoutBurnOutput', amount: bigint, indent: boolean }

/**
 * Rows for the "Removed from supply" group. `removedFT` is genesis minus all unspent FT
 * (undefined until the holder query loaded), `burnedFT` the FT sent to burn outputs
 * (undefined if the burn query failed). Removed = burned + removed without a burn output.
 * The total with both parts indented only when both parts are > 0; otherwise the one
 * non-zero part as a single row. Negative figures mean stale Chaingraph data: they're
 * never shown, and `inconsistent` is set instead.
 */
export function supplyRemovalRows(removedFT: bigint | undefined, burnedFT: bigint | undefined): { rows: SupplyRemovalRow[], withoutBurnOutputFT?: bigint, inconsistent: boolean } {
  const burnedRow = (indent: boolean): SupplyRemovalRow[] =>
    burnedFT !== undefined && burnedFT > 0n ? [{ kind: 'burned', amount: burnedFT, indent }] : []
  if (removedFT === undefined) return { rows: burnedRow(false), inconsistent: false }
  if (removedFT < 0n) return { rows: burnedRow(false), inconsistent: true }
  if (burnedFT === undefined) {
    return { rows: removedFT > 0n ? [{ kind: 'removed', amount: removedFT }] : [], inconsistent: false }
  }
  const withoutBurnOutputFT = removedFT - burnedFT
  if (withoutBurnOutputFT < 0n) return { rows: burnedRow(false), inconsistent: true }
  if (burnedFT > 0n && withoutBurnOutputFT > 0n) {
    return {
      rows: [
        { kind: 'removed', amount: removedFT },
        { kind: 'burned', amount: burnedFT, indent: true },
        { kind: 'withoutBurnOutput', amount: withoutBurnOutputFT, indent: true },
      ],
      withoutBurnOutputFT,
      inconsistent: false,
    }
  }
  if (withoutBurnOutputFT > 0n) {
    return { rows: [{ kind: 'withoutBurnOutput', amount: withoutBurnOutputFT, indent: false }], withoutBurnOutputFT, inconsistent: false }
  }
  return { rows: burnedRow(false), withoutBurnOutputFT, inconsistent: false }
}

export interface BurnTransaction {
  txHash: string
  /** block timestamp, undefined while unconfirmed */
  timestamp?: number
  methods: BurnEntry['method'][]
  fungibleTokenAmount: bigint
  nftCount: number
}

/**
 * Group burn outputs by transaction, keeping the input order (latest first from
 * aggregateBurns). A protocol often burns FT and an NFT in one transaction, e.g. a
 * closed loan's repaid tokens and its loan NFT.
 */
export function groupBurnsByTransaction(burns: BurnEntry[]): BurnTransaction[] {
  const byTx = new Map<string, BurnTransaction>()
  for (const burn of burns) {
    let tx = byTx.get(burn.txHash)
    if (!tx) {
      tx = { txHash: burn.txHash, timestamp: burn.timestamp, methods: [], fungibleTokenAmount: 0n, nftCount: 0 }
      byTx.set(burn.txHash, tx)
    }
    if (!tx.methods.includes(burn.method)) tx.methods.push(burn.method)
    tx.fungibleTokenAmount += burn.fungibleTokenAmount
    if (burn.nftCapability !== null) tx.nftCount++
  }
  return [...byTx.values()]
}
