import { describe, expect, it } from 'vitest'
import { isValidOutput } from './queryChainGraph'

describe('isValidOutput', () => {
  it('keeps outputs of transactions in a mempool or in a block', () => {
    expect(isValidOutput({ transaction: { node_validations: [{}], block_inclusions: [] } })).toBe(true)
    expect(isValidOutput({ transaction: { node_validations: [], block_inclusions: [{}] } })).toBe(true)
  })

  it('drops outputs of transactions that were dropped from the mempool', () => {
    expect(isValidOutput({ transaction: { node_validations: [], block_inclusions: [] } })).toBe(false)
  })

  it('drops outputs without transaction data', () => {
    expect(isValidOutput({ transaction: null })).toBe(false)
    expect(isValidOutput({})).toBe(false)
  })
})
