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
