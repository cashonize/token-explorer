import { describe, expect, it } from 'vitest'
import { fetchRemainingPages, isValidOutput, OUTPUT_PAGE_SIZE, type OutputPage } from './queryChainGraph'

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

describe('fetchRemainingPages', () => {
  const page = (rows: number, valid = rows): OutputPage<number> => ({ output: Array.from({ length: valid }, (_, i) => i), pageSize: rows })

  it('fetches no more pages after a short first page', async () => {
    const fetched: number[] = []
    const result = await fetchRemainingPages(page(10), offset => { fetched.push(offset); return Promise.resolve(page(0)) })
    expect(fetched).toEqual([])
    expect(result).toHaveLength(10)
  })

  it('keeps paginating when a full page loses rows to the validity filter', async () => {
    const fetched: number[] = []
    const pages = [page(OUTPUT_PAGE_SIZE, 4990), page(3)]
    const result = await fetchRemainingPages(pages[0]!, offset => { fetched.push(offset); return Promise.resolve(pages[fetched.length]) })
    expect(fetched).toEqual([OUTPUT_PAGE_SIZE])
    expect(result).toHaveLength(4993)
  })

  it('reports a failed page and a superseded search', async () => {
    expect(await fetchRemainingPages(page(OUTPUT_PAGE_SIZE), () => Promise.resolve(undefined))).toBe('error')
    expect(await fetchRemainingPages(page(OUTPUT_PAGE_SIZE), () => Promise.resolve(page(1)), () => false)).toBe('stale')
  })
})
