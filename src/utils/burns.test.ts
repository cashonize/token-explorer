import { describe, expect, it } from 'vitest'
import { lockingBytecodeToCashAddress, hexToBin } from '@bitauth/libauth'
import { TOKENBURNER_LOCKING_BYTECODE } from '@/constants'
import type { BurnEntry } from '@/interfaces'
import { aggregateBurns, groupBurnsByTransaction, isKnownBurnLockingBytecode } from './burns'
import { parseBurnRows, type BurnOutputRow } from './queryChainGraph'

const burn = (overrides: Partial<BurnEntry> & Pick<BurnEntry, 'txHash'>): BurnEntry => ({
  vout: 0,
  method: 'op_return',
  fungibleTokenAmount: 0n,
  nftCapability: null,
  ...overrides,
})

describe('TOKENBURNER_LOCKING_BYTECODE', () => {
  it('is the P2SH32 of the tokenburner.cash burner redeem script', () => {
    expect(TOKENBURNER_LOCKING_BYTECODE).toBe('aa20fe61963d65350d4baaa445b4697243b1f48c99e8daed32aaf67d5e33534d87fc87')
  })

  it('encodes to the token-aware burner address published by tokenburner.cash', () => {
    const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(TOKENBURNER_LOCKING_BYTECODE), prefix: 'bitcoincash', tokenSupport: true })
    expect(typeof result === 'string' ? result : result.address)
      .toBe('bitcoincash:r0lxr93av56s6ja253zmg6tjgwclfryeardw6v427e74uv6nfkrlc2s5qtune')
  })
})

describe('isKnownBurnLockingBytecode', () => {
  it('matches OP_RETURN outputs, bare or with data pushes', () => {
    expect(isKnownBurnLockingBytecode('6a')).toBe(true)
    expect(isKnownBurnLockingBytecode('6a0653554d4d4f4e')).toBe(true)
  })

  it('matches the burner contract', () => {
    expect(isKnownBurnLockingBytecode(TOKENBURNER_LOCKING_BYTECODE)).toBe(true)
    expect(isKnownBurnLockingBytecode(TOKENBURNER_LOCKING_BYTECODE.toUpperCase())).toBe(true)
  })

  it('does not match spendable outputs', () => {
    expect(isKnownBurnLockingBytecode('76a914' + '6a'.repeat(20) + '88ac')).toBe(false) // P2PKH
    expect(isKnownBurnLockingBytecode('aa20' + '00'.repeat(32) + '87')).toBe(false) // another P2SH32
  })
})

describe('aggregateBurns', () => {
  it('returns zeros for no burns', () => {
    expect(aggregateBurns([])).toEqual({ burnedFT: 0n, burnedNFTs: 0, burns: [] })
  })

  it('sums FT and counts NFT outputs across both methods', () => {
    const result = aggregateBurns([
      burn({ txHash: 'aa', fungibleTokenAmount: 1000n, timestamp: 100 }),
      burn({ txHash: 'bb', nftCapability: 'none', timestamp: 200 }),
      burn({ txHash: 'cc', method: 'tokenburner', fungibleTokenAmount: 5n, nftCapability: 'mutable', timestamp: 300 }),
      burn({ txHash: 'dd', method: 'tokenburner', fungibleTokenAmount: 7n, timestamp: 50 }),
    ])
    expect(result.burnedFT).toBe(1012n)
    expect(result.burnedNFTs).toBe(2)
    expect(result.burns).toHaveLength(4)
  })

  it('counts an immutable NFT without FT (capability "none") as a burned NFT', () => {
    expect(aggregateBurns([burn({ txHash: 'aa', nftCapability: 'none' })]).burnedNFTs).toBe(1)
  })

  it('orders the latest burn first, unconfirmed before confirmed', () => {
    const result = aggregateBurns([
      burn({ txHash: 'old', timestamp: 100 }),
      burn({ txHash: 'mempool' }),
      burn({ txHash: 'new', timestamp: 300 }),
    ])
    expect(result.burns.map(b => b.txHash)).toEqual(['mempool', 'new', 'old'])
  })

  it('counts an outpoint returned twice (e.g. on overlapping pages) once', () => {
    const result = aggregateBurns([
      burn({ txHash: 'aa', vout: 1, fungibleTokenAmount: 10n }),
      burn({ txHash: 'aa', vout: 1, fungibleTokenAmount: 10n }),
      burn({ txHash: 'aa', vout: 2, fungibleTokenAmount: 10n }),
    ])
    expect(result.burnedFT).toBe(20n)
    expect(result.burns).toHaveLength(2)
  })
})

describe('parseBurnRows', () => {
  const row = (txHash: string, transaction: BurnOutputRow['transaction']): BurnOutputRow => ({
    transaction_hash: `\\x${txHash}`,
    output_index: '2',
    fungible_token_amount: '1500',
    nonfungible_token_capability: null,
    transaction,
  })

  it('maps a confirmed row, with its block timestamp', () => {
    const [entry] = parseBurnRows([row('aa', { node_validations: [], block_inclusions: [{ block: { timestamp: '1700000000' } }] })], 'tokenburner')
    expect(entry).toEqual({ txHash: 'aa', vout: 2, method: 'tokenburner', fungibleTokenAmount: 1500n, nftCapability: null, timestamp: 1700000000 })
  })

  it('keeps a mempool transaction, without timestamp', () => {
    const entries = parseBurnRows([row('bb', { node_validations: [{ validated_at: '2026-01-01T00:00:00' }], block_inclusions: [] })], 'op_return')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.timestamp).toBeUndefined()
  })

  it('drops a transaction that is neither in a mempool nor in a block (e.g. lost a double-spend)', () => {
    expect(parseBurnRows([row('cc', { node_validations: [], block_inclusions: [] })], 'op_return')).toEqual([])
  })
})

describe('groupBurnsByTransaction', () => {
  it('returns nothing for no burns', () => {
    expect(groupBurnsByTransaction([])).toEqual([])
  })

  it('merges the outputs of one transaction (e.g. repaid FT plus a closed loan NFT), keeping order', () => {
    const { burns } = aggregateBurns([
      burn({ txHash: 'loan', vout: 2, fungibleTokenAmount: 400n, timestamp: 300 }),
      burn({ txHash: 'loan', vout: 3, nftCapability: 'mutable', timestamp: 300 }),
      burn({ txHash: 'older', method: 'tokenburner', fungibleTokenAmount: 7n, timestamp: 100 }),
    ])
    expect(groupBurnsByTransaction(burns)).toEqual([
      { txHash: 'loan', timestamp: 300, methods: ['op_return'], fungibleTokenAmount: 400n, nftCount: 1 },
      { txHash: 'older', timestamp: 100, methods: ['tokenburner'], fungibleTokenAmount: 7n, nftCount: 0 },
    ])
  })

  it('lists each method once for a transaction burning both ways', () => {
    const [tx] = groupBurnsByTransaction([
      burn({ txHash: 'mixed', vout: 0, method: 'op_return', fungibleTokenAmount: 1n }),
      burn({ txHash: 'mixed', vout: 1, method: 'tokenburner', fungibleTokenAmount: 2n }),
      burn({ txHash: 'mixed', vout: 2, method: 'op_return', fungibleTokenAmount: 3n }),
    ])
    expect(tx?.methods).toEqual(['op_return', 'tokenburner'])
    expect(tx?.fungibleTokenAmount).toBe(6n)
  })
})
