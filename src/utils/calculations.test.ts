import { describe, expect, it } from 'vitest'
import { countUniqueHolders } from './calculations'

const P2PKH_A = '\\x76a914' + 'aa'.repeat(20) + '88ac'
const P2PKH_B = '\\x76a914' + 'bb'.repeat(20) + '88ac'
const P2SH32 = '\\xaa20' + 'cc'.repeat(32) + '87'

const output = (txHash: string, vout: number, locking_bytecode: string, ft: string, capability: string | null = null) => ({
  transaction_hash: `\\x${txHash}`,
  output_index: String(vout),
  locking_bytecode,
  fungible_token_amount: ft,
  nonfungible_token_capability: capability,
})

describe('countUniqueHolders', () => {
  it('splits circulating FT between user and contract addresses', () => {
    const result = countUniqueHolders([
      output('01', 0, P2PKH_A, '100'),
      output('02', 0, P2PKH_A, '50'),
      output('03', 1, P2PKH_B, '25'),
      output('04', 0, P2SH32, '1000'),
    ])
    expect(result).toEqual({ numberHolders: 2, numberTokenAddresses: 3, userSupplyFT: 175n, contractSupplyFT: 1000n })
  })

  it('leaves reserved outputs out of the split, also on a user address (e.g. an authhead identity output)', () => {
    const outputs = [
      output('01', 0, P2PKH_A, '130900'), // authhead identity output holding reserved supply
      output('02', 0, P2PKH_B, '91'),
      output('03', 0, P2SH32, '500', 'minting'), // issuing covenant
      output('04', 0, P2SH32, '9'),
    ]
    const result = countUniqueHolders(outputs, new Set(['01:0', '03:0']))
    expect(result.userSupplyFT).toBe(91n)
    expect(result.contractSupplyFT).toBe(9n)
    // the address holding only reserved supply still counts as a holding address
    expect(result.numberHolders).toBe(2)
  })

  it('treats minting/mutable NFT outputs as reserved even without their outpoint (issuing query failed)', () => {
    const result = countUniqueHolders([
      output('01', 0, P2PKH_A, '40', 'mutable'),
      output('02', 0, P2PKH_B, '2', 'none'),
    ])
    expect(result.userSupplyFT).toBe(2n)
  })
})
