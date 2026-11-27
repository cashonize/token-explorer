import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  RECHECK_AFTER_MS,
  forgetChaingraphCapabilities,
  readUnspentOutputs,
  type ChaingraphQueryResult,
  type ChaingraphNodesData,
  type ChaingraphQueryRunner,
  type KeyedOutput,
  type OutputCursor,
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
  const answer = (document: string): ChaingraphQueryResult<unknown> => {
    if (document.includes("ChaingraphCapabilities")) {
      requests.capabilityChecks += 1
      if (instance.checkFails) return { error: { message: "[Network] Failed to fetch" } }
      const fields = ["output", "transaction", ...(instance.hasRoot ? ["unspent_output"] : [])]
      return {
        data: {
          node: instance.nodeNames.map(name => ({ name })),
          __type: { fields: fields.map(name => ({ name })) },
        },
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
        },
      }
    }
    throw new Error(`unexpected document: ${document}`)
  }
  // The fake answers with the shape each document asks for; the runner's type can't know that
  const runQuery = ((document: string) => Promise.resolve(answer(document))) as ChaingraphQueryRunner
  return { runQuery, requests }
}

const rootRow = { output_index: "0", source: "unspent_output" }
const genericRow = { output_index: "0", source: "output" }
const fromRoot = { data: { output: [rootRow] } }
const fromGeneric = { data: { output: [genericRow] } }
type Row = typeof rootRow
type Page = ChaingraphQueryResult<{ output: Row[] } & ChaingraphNodesData>

// Single-page reads that record which way the outputs were read. The unspent_output read answers
// like an instance that has the nodes `instance.nodeNames`, or fails with `withRootError`.
function fakeReads({ withRootError, instance }: { withRootError?: { message: string }, instance?: FakeInstance } = {}) {
  const readWithRoot = vi.fn<(nodeName: string, after: OutputCursor | undefined) => Promise<Page>>(nodeName => {
    if (withRootError) return Promise.resolve({ error: withRootError })
    const nodeNames = instance?.nodeNames ?? [nodeName]
    return Promise.resolve({ data: { output: [rootRow], chaingraph_nodes: nodeNames.map(name => ({ name })) } })
  })
  const readWithoutRoot = vi.fn<(after: OutputCursor | undefined) => Promise<ChaingraphQueryResult<{ output: Row[] }>>>(() => Promise.resolve(fromGeneric))
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

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)

    expect(reads.readWithRoot).toHaveBeenCalledWith("bchn-mainnet", undefined)
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
    expect(reads.readWithRoot).toHaveBeenNthCalledWith(1, "bchn-chipnet", undefined)
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

    expect(reads.readWithRoot).toHaveBeenCalledWith("bchn-mainnet", undefined)
  })

  it("uses the generic query when no node accepts the token's category transaction", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet", "bchn-chipnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    expect(reads.readWithRoot).not.toHaveBeenCalled()
  })

  it("looks up the node again on the next query when no node accepted the transaction yet", async () => {
    const instance: FakeInstance = { hasRoot: true, nodeNames: ["bchn-mainnet", "bchn-chipnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads({ instance })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    instance.acceptedInMempoolBy = ["bchn-mainnet"]

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(reads.readWithRoot).toHaveBeenCalledWith("bchn-mainnet", undefined)
    expect(requests).toEqual({ capabilityChecks: 1, nodeLookups: 2 })
  })

  it("looks up the node again after checking the instance again", async () => {
    const instance: FakeInstance = { hasRoot: true, nodeNames: ["bchn-mainnet", "bchn-chipnet"], acceptedInBlockBy: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads({ instance })

    await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })
    // Another instance, with other node names, now answers behind the same URL
    Object.assign(instance, { nodeNames: ["mainnet", "chipnet"], acceptedInBlockBy: ["mainnet"] })
    vi.setSystemTime(Date.now() + RECHECK_AFTER_MS + 1000)

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(reads.readWithRoot.mock.calls).toEqual([["bchn-mainnet", undefined], ["mainnet", undefined]])
    expect(requests).toEqual({ capabilityChecks: 2, nodeLookups: 2 })
  })

  it("uses the generic query when the instance doesn't have the node, and checks again on the next query", async () => {
    const instance: FakeInstance = { hasRoot: true, nodeNames: ["bchn-mainnet", "bchn-chipnet"], acceptedInBlockBy: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads({ instance })

    await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })
    // Within the cache time, another instance with other node names takes over the URL
    Object.assign(instance, { nodeNames: ["mainnet", "chipnet"], acceptedInBlockBy: ["mainnet"] })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(reads.readWithRoot.mock.calls).toEqual([["bchn-mainnet", undefined], ["bchn-mainnet", undefined], ["mainnet", undefined]])
    expect(requests).toEqual({ capabilityChecks: 2, nodeLookups: 2 })
  })

  it("uses the generic query when the instance doesn't have unspent_output", async () => {
    const { runQuery, requests } = fakeInstance({ hasRoot: false, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    expect(reads.readWithRoot).not.toHaveBeenCalled()
    expect(requests).toEqual({ capabilityChecks: 1, nodeLookups: 0 })
  })

  it("switches to the generic query when unspent_output is rejected, and keeps using it", async () => {
    // The check said yes, then another instance without the root took over the endpoint
    const { runQuery, requests } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads({ withRootError: missingRootError })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)

    expect(reads.readWithRoot).toHaveBeenCalledTimes(1)
    expect(reads.readWithoutRoot).toHaveBeenCalledTimes(2)
    expect(requests.capabilityChecks).toBe(1)
  })

  it("passes on other errors of an unspent_output query without falling back", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const timeout = { message: "[GraphQL] canceling statement due to statement timeout" }
    const reads = fakeReads({ withRootError: timeout })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ error: timeout })
    expect(reads.readWithoutRoot).not.toHaveBeenCalled()
  })

  it("checks again after some minutes, so a switch to an instance with unspent_output is picked up", async () => {
    const instance: FakeInstance = { hasRoot: false, nodeNames: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    instance.hasRoot = true

    vi.setSystemTime(Date.now() + RECHECK_AFTER_MS - 1000)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    expect(requests.capabilityChecks).toBe(1)

    vi.setSystemTime(Date.now() + 2000)
    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(requests.capabilityChecks).toBe(2)
  })

  it("checks again on the next query after the generic query fails", async () => {
    const instance: FakeInstance = { hasRoot: false, nodeNames: ["bchn-mainnet"] }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()
    reads.readWithoutRoot.mockResolvedValueOnce({ error: { message: "[GraphQL] timeout" } })

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual({ error: { message: "[GraphQL] timeout" } })
    instance.hasRoot = true

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(requests.capabilityChecks).toBe(2)
  })

  it("uses the generic query when the check fails, and checks again on the next query", async () => {
    const instance: FakeInstance = { hasRoot: true, nodeNames: ["bchn-mainnet"], checkFails: true }
    const { runQuery, requests } = fakeInstance(instance)
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromGeneric)
    instance.checkFails = false

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery, ...reads })).toEqual(fromRoot)
    expect(requests.capabilityChecks).toBe(2)
  })

  it("keeps what it knows per endpoint", async () => {
    const withRoot = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const withoutRoot = fakeInstance({ hasRoot: false, nodeNames: ["bchn-mainnet"] })
    const reads = fakeReads()

    expect(await readUnspentOutputs({ endpoint, tokenId, runQuery: withRoot.runQuery, ...reads }))
      .toEqual(fromRoot)
    expect(await readUnspentOutputs({ endpoint: "https://other.example/v1/graphql", tokenId, runQuery: withoutRoot.runQuery, ...reads }))
      .toEqual(fromGeneric)
  })
})

// A paged fake: outputs keyed by (internal_id, output_index), served in key order after a cursor, two per page
interface FakeOutput extends KeyedOutput {
  transaction: { internal_id: string }
  label: string
}

function fakeOutput(internalId: number, outputIndex: number): FakeOutput {
  return { output_index: String(outputIndex), transaction: { internal_id: String(internalId) }, label: `${internalId}:${outputIndex}` }
}

function pagedServer(outputs: FakeOutput[], nodeNames = ["bchn-mainnet"]) {
  const state = { outputs, nodeNames }
  const key = (output: FakeOutput) => [BigInt(output.transaction.internal_id), BigInt(output.output_index)] as const
  const isAfter = (output: FakeOutput, cursor: OutputCursor | undefined) => {
    if (!cursor) return true
    const [internalId, outputIndex] = key(output)
    return internalId > BigInt(cursor.internalId) || (internalId === BigInt(cursor.internalId) && outputIndex > BigInt(cursor.outputIndex))
  }
  const page = (after: OutputCursor | undefined) => {
    const sorted = [...state.outputs].sort((a, b) => {
      const [aId, aIndex] = key(a), [bId, bIndex] = key(b)
      return aId === bId ? Number(aIndex - bIndex) : Number(aId - bId)
    })
    return {
      data: {
        output: sorted.filter(output => isAfter(output, after)).slice(0, 2),
        chaingraph_nodes: state.nodeNames.map(name => ({ name })),
      },
    }
  }
  return { state, page }
}

const labels = (result: ChaingraphQueryResult<{ output: FakeOutput[] }>) => result.data?.output.map(output => output.label)

describe("readUnspentOutputs paging", () => {
  it("asks each page for the outputs after the last one read", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(5, 1), fakeOutput(7, 0), fakeOutput(9, 2), fakeOutput(9, 3)])
    const readWithRoot = vi.fn((_nodeName: string, after: OutputCursor | undefined) => Promise.resolve(server.page(after)))
    const readWithoutRoot = vi.fn((after: OutputCursor | undefined) => Promise.resolve(server.page(after)))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })

    expect(labels(result)).toEqual(["5:0", "5:1", "7:0", "9:2", "9:3"])
    expect(readWithRoot.mock.calls.map(([, after]) => after)).toEqual([
      undefined,
      { internalId: "5", outputIndex: "1" },
      { internalId: "9", outputIndex: "2" },
    ])
    expect(readWithoutRoot).not.toHaveBeenCalled()
  })

  it("neither repeats nor skips outputs when earlier outputs join or leave the set during the scan", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(6, 0), fakeOutput(7, 0), fakeOutput(8, 0), fakeOutput(9, 0)])
    const readWithRoot = vi.fn((_nodeName: string, after: OutputCursor | undefined) => {
      const answer = server.page(after)
      if (!after) {
        // After the first page: an output already read is spent, an older transaction's output joins
        // behind the cursor, and a new transaction creates an output (a higher internal_id)
        server.state.outputs = [fakeOutput(1, 0), ...server.state.outputs.filter(output => output.label !== "5:0"), fakeOutput(10, 0)]
      }
      return Promise.resolve(answer)
    })
    const readWithoutRoot = vi.fn(() => Promise.resolve({}))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })

    // The unchanged outputs come once each; the spent one stays as read, the one behind the cursor is not read
    expect(labels(result)).toEqual(["5:0", "6:0", "7:0", "8:0", "9:0", "10:0"])
  })

  it("starts again from the beginning with the generic query when unspent_output is rejected partway", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(6, 0), fakeOutput(7, 0)])
    const readWithRoot = vi.fn((_nodeName: string, after: OutputCursor | undefined) =>
      Promise.resolve(after ? { error: missingRootError } : server.page(after)))
    const readWithoutRoot = vi.fn((after: OutputCursor | undefined) => Promise.resolve(server.page(after)))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })

    expect(labels(result)).toEqual(["5:0", "6:0", "7:0"])
    expect(readWithoutRoot.mock.calls.map(([after]) => after)).toEqual([undefined, { internalId: "6", outputIndex: "0" }])
  })

  it("starts again with the generic query when the node is gone partway", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(6, 0), fakeOutput(7, 0)])
    const readWithRoot = vi.fn((_nodeName: string, after: OutputCursor | undefined) => {
      const answer = server.page(after)
      server.state.nodeNames = ["mainnet"]
      return Promise.resolve(answer)
    })
    const readWithoutRoot = vi.fn((after: OutputCursor | undefined) => Promise.resolve(server.page(after)))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })

    expect(labels(result)).toEqual(["5:0", "6:0", "7:0"])
    expect(readWithRoot).toHaveBeenCalledTimes(2)
    expect(readWithoutRoot.mock.calls[0]).toEqual([undefined])
  })

  it("starts again from the beginning when the instance changes partway, and gives up if it keeps changing", async () => {
    const { runQuery } = fakeInstance({ hasRoot: false, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(6, 0), fakeOutput(7, 0)])
    let instanceChanges = 1
    const readWithoutRoot = vi.fn((after: OutputCursor | undefined) => {
      const answer = server.page(after)
      if (after && instanceChanges > 0) {
        instanceChanges -= 1
        answer.data.chaingraph_nodes = [{ name: "bchn-mainnet (another instance)" }]
      }
      return Promise.resolve(answer)
    })
    const readWithRoot = vi.fn(() => Promise.resolve({}))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })
    expect(labels(result)).toEqual(["5:0", "6:0", "7:0"])
    expect(readWithoutRoot.mock.calls.map(([after]) => after)).toEqual([
      undefined, { internalId: "6", outputIndex: "0" },
      undefined, { internalId: "6", outputIndex: "0" },
    ])

    instanceChanges = Infinity
    const keepsChanging = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot })
    expect(keepsChanging.error?.message).toContain("changed")
  })

  it("stops between pages once the search is superseded", async () => {
    const { runQuery } = fakeInstance({ hasRoot: true, nodeNames: ["bchn-mainnet"] })
    const server = pagedServer([fakeOutput(5, 0), fakeOutput(6, 0), fakeOutput(7, 0)])
    const readWithRoot = vi.fn((_nodeName: string, after: OutputCursor | undefined) => Promise.resolve(server.page(after)))
    const readWithoutRoot = vi.fn(() => Promise.resolve({}))

    const result = await readUnspentOutputs({ endpoint, tokenId, runQuery, pageSize: 2, readWithRoot, readWithoutRoot, isCurrent: () => false })

    expect(result).toEqual({})
    expect(readWithRoot).toHaveBeenCalledTimes(1)
  })
})
