import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  RECHECK_AFTER_MS,
  forgetChaingraphCapabilities,
  readUnspentOutputs,
  type ChaingraphQueryResult,
  type ChaingraphQueryRunner,
} from "./unspentOutputRoot"

const endpoint = "https://chaingraph.example/v1/graphql"
const tokenId = "d9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea"
const missingRootError = { message: "[GraphQL] field 'unspent_output' not found in type: 'query_root'" }

interface FakeInstance {
  hasRoot: boolean
  nodeNames: string[]
  acceptedInBlockBy?: string[]
  acceptedInMempoolBy?: string[]
  checkFails?: boolean
}

// A fake instance answering the capability check and the node lookup; counts each kind of request
function fakeInstance(instance: FakeInstance) {
  const requests = { capabilityChecks: 0, nodeLookups: 0 }
  const runQuery: ChaingraphQueryRunner = async <Data,>(document: string) => {
    if (document.includes("ChaingraphCapabilities")) {
      requests.capabilityChecks += 1
      if (instance.checkFails) return { error: { message: "[Network] Failed to fetch" } }
      const fields = ["output", "transaction", ...(instance.hasRoot ? ["unspent_output"] : [])]
      return {
        data: {
          node: instance.nodeNames.map(name => ({ name })),
          __type: { fields: fields.map(name => ({ name })) },
        } as Data,
      }
    }
    if (document.includes("NodesAcceptingTransaction")) {
      requests.nodeLookups += 1
      return {
        data: {
          transaction: [{
            node_validations: (instance.acceptedInMempoolBy ?? []).map(name => ({ node: { name } })),
            block_inclusions: [{
              block: { accepted_by: (instance.acceptedInBlockBy ?? []).map(name => ({ node: { name } })) },
            }],
          }],
        } as Data,
      }
    }
    throw new Error(`unexpected document: ${document}`)
  }
  return { runQuery, requests }
}

// Reads that record which way the outputs were read
function fakeReads(withRootResult: ChaingraphQueryResult<string> = { data: "from unspent_output" }) {
  const readWithRoot = vi.fn(async (_nodeName: string) => withRootResult)
  const readWithoutRoot = vi.fn(async (): Promise<ChaingraphQueryResult<string>> => ({ data: "from output" }))
  return { readWithRoot, readWithoutRoot }
}

beforeEach(() => {
  forgetChaingraphCapabilities()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"))
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("readUnspentOutputs", () => {
  it("reads through unspent_output when the instance has it, checking the instance once", async () => {
    const { runQuery, requests } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from unspent_output" })
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from unspent_output" })

    expect(reads.readWithRoot).toHaveBeenCalledWith("bchn-mainnet")
    expect(reads.readWithoutRoot).not.toHaveBeenCalled()
    expect(requests).toEqual({ capabilityChecks: 1, nodeLookups: 0 })
  })

  it("uses the node that accepts the token's category transaction when the instance has several", async () => {
    const { runQuery, requests } = fakeInstance({
      hasRoot: true,
      nodeNames: ["bchn-mainnet", "bchn-chipnet"],
      acceptedInBlockBy: ["bchn-chipnet"],
    })
    const reads = fakeReads()

    await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })
    await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })

    expect(reads.readWithRoot).toHaveBeenCalledTimes(2)
    expect(reads.readWithRoot).toHaveBeenNthCalledWith(1, "bchn-chipnet")
    expect(requests).toEqual({ capabilityChecks: 1, nodeLookups: 1 })
  })

  it("finds the node of a transaction that is only in a mempool", async () => {
    const { runQuery } = fakeInstance({
      hasRoot: true,
      nodeNames: ["bchn-mainnet", "bchn-chipnet"],
      acceptedInMempoolBy: ["bchn-mainnet"],
    })
    const reads = fakeReads()

    await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })

    expect(reads.readWithRoot).toHaveBeenCalledWith("bchn-mainnet")
  })

  it("uses the generic query when no node accepts the token's category transaction", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet", "bchn-chipnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    expect(reads.readWithRoot).not.toHaveBeenCalled()
  })

  it("uses the generic query when the instance doesn't have unspent_output", async () => {
    const { runQuery, requests } = fakeInstance({ hasRoot: false, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    expect(reads.readWithRoot).not.toHaveBeenCalled()
    expect(requests).toEqual({ capabilityChecks: 1, nodeLookups: 0 })
  })

  it("switches to the generic query when unspent_output is rejected, and keeps using it", async () => {
    // The check said yes, then another instance without the root took over the endpoint
    const { runQuery, requests } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads({ error: missingRootError })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })

    expect(reads.readWithRoot).toHaveBeenCalledTimes(1)
    expect(reads.readWithoutRoot).toHaveBeenCalledTimes(2)
    expect(requests.capabilityChecks).toBe(1)
  })

  it("passes on other errors of an unspent_output query without falling back", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const timeout = { message: "[GraphQL] canceling statement due to statement timeout" }
    const reads = fakeReads({ error: timeout })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ error: timeout })
    expect(reads.readWithoutRoot).not.toHaveBeenCalled()
  })

  it("checks again after some minutes, so a switch to an instance with unspent_output is picked up", async () => {
    const instance: FakeInstance = { hasRoot: false, nodeNames: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    instance.hasRoot = true

    vi.setSystemTime(Date.now() + RECHECK_AFTER_MS - 1000)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    expect(requests.capabilityChecks).toBe(1)

    vi.setSystemTime(Date.now() + 2000)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from unspent_output" })
    expect(requests.capabilityChecks).toBe(2)
  })

  it("checks again on the next query after the generic query fails", async () => {
    const instance: FakeInstance = { hasRoot: false, nodeNames: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()
    reads.readWithoutRoot.mockResolvedValueOnce({ error: { message: "[GraphQL] timeout" } })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ error: { message: "[GraphQL] timeout" } })
    instance.hasRoot = true

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from unspent_output" })
    expect(requests.capabilityChecks).toBe(2)
  })

  it("uses the generic query when the check fails, and checks again on the next query", async () => {
    const instance: FakeInstance = { hasRoot: true, nodeNames: ["bchn-mainnet"], checkFails: true }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from output" })
    instance.checkFails = false

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ data: "from unspent_output" })
    expect(requests.capabilityChecks).toBe(2)
  })

  it("keeps what it knows per endpoint", async () => {
    const withRoot = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const withoutRoot = fakeInstance({ hasRoot: false, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery: withRoot.runQuery, ...reads }))
      .toEqual({ data: "from unspent_output" })
    expect(await readUnspentOutputs({ endpoint: "https://other.example/v1/graphql", tokenId, runQuery: withoutRoot.runQuery, ...reads }))
      .toEqual({ data: "from output" })
  })
})
