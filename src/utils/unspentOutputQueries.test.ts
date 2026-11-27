import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryAllTokenHolders, queryIssuingUtxos } from "./queryChainGraph"
import { forgetChaingraphCapabilities } from "./unspentOutputRoot"

const tokenId = "d9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea"
const tokenOutput = {
  transaction_hash: "\\x01",
  output_index: "0",
  locking_bytecode: "\\x76a914",
  fungible_token_amount: "100",
  nonfungible_token_capability: null,
  transaction: { internal_id: "42" },
}
const chaingraphNodes = [{ name: "bchn-mainnet", internal_id: "1", first_connected_at: "2026-01-01T00:00:00", latest_connection_began_at: "2026-11-01T00:00:00" }]

interface GraphqlRequest {
  query: string
  variables: Record<string, unknown>
}

// Stands in for a Chaingraph instance over HTTP; `hasRoot` decides how it answers, `pages` what the
// holder query returns page by page (one output per page by default)
function mockChaingraph({ hasRoot, pages = [[tokenOutput]] }: { hasRoot: boolean, pages?: (typeof tokenOutput)[][] }) {
  let holderPage = 0
  const requests: GraphqlRequest[] = []
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as GraphqlRequest
    requests.push(request)
    let body: unknown
    if (request.query.includes("query ChaingraphCapabilities")) {
      const fields = ["output", ...(hasRoot ? ["unspent_output"] : [])]
      body = { data: { node: [{ name: "bchn-mainnet" }], __type: { fields: fields.map(name => ({ name })) } } }
    } else if (request.query.includes("unspent_output") && !hasRoot) {
      body = { errors: [{ extensions: { code: "validation-failed", path: "$.selectionSet.unspent_output" }, message: "field 'unspent_output' not found in type: 'query_root'" }] }
    } else {
      const isHolderQuery = request.query.includes("query TotalSupplyFT")
      const output = isHolderQuery ? pages[holderPage++] ?? [] : [tokenOutput]
      body = { data: { chaingraph_nodes: chaingraphNodes, output } }
    }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }))
  }))
  return requests
}

beforeEach(() => {
  forgetChaingraphCapabilities()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("unspent output queries", () => {
  it("send unspent_output with the node name when the instance has it", async () => {
    const requests = mockChaingraph({ hasRoot: true })

    expect(await queryAllTokenHolders(tokenId)).toEqual({ output: [tokenOutput] })
    expect(await queryIssuingUtxos(tokenId)).toEqual({ output: [tokenOutput] })

    const [check, holders, issuing] = requests
    expect(requests).toHaveLength(3)
    expect(check?.query).toContain("query ChaingraphCapabilities")
    expect(holders?.query).toContain("output: unspent_output(")
    expect(holders?.variables).toEqual({ tokenId: `\\x${tokenId}`, limit: 5000, after: {}, node: "bchn-mainnet" })
    expect(issuing?.query).toContain("IssuingUtxosUnspent")
    expect(issuing?.query).toContain("chaingraph_nodes: node(")
  })

  it("send the generic query when the instance doesn't have unspent_output", async () => {
    const requests = mockChaingraph({ hasRoot: false })

    expect(await queryAllTokenHolders(tokenId)).toEqual({ output: [tokenOutput] })

    const [, holders] = requests
    expect(requests).toHaveLength(2)
    expect(holders?.query).toContain("spent_by")
    expect(holders?.query).not.toContain("unspent_output")
  })

  it.each([true, false])("page the holder query in key order after the last output read (unspent_output: %s)", async hasRoot => {
    const fullPage = Array.from({ length: 5000 }, (_, index) => ({ ...tokenOutput, output_index: String(index) }))
    const lastPage = [{ ...tokenOutput, transaction: { internal_id: "43" } }]
    const requests = mockChaingraph({ hasRoot, pages: [fullPage, lastPage] })

    const result = await queryAllTokenHolders(tokenId)

    expect(result?.output).toHaveLength(5001)
    const holderRequests = requests.filter(request => request.query.includes("query TotalSupplyFT"))
    for (const request of holderRequests) {
      expect(request.query.replace(/\s+/g, " ")).toContain("order_by: [{transaction: {internal_id: asc}}, {output_index: asc}]")
      expect(request.query).toContain("chaingraph_nodes: node(")
    }
    expect(holderRequests.map(request => request.variables.after)).toEqual([
      {},
      { _or: [
        { transaction: { internal_id: { _gt: "42" } } },
        { transaction: { internal_id: { _eq: "42" } }, output_index: { _gt: "4999" } },
      ] },
    ])
  })

  it("rerun with the generic query when Hasura rejects unspent_output", async () => {
    mockChaingraph({ hasRoot: true })
    expect(await queryIssuingUtxos(tokenId)).toEqual({ output: [tokenOutput] })

    // Another instance without the root now answers behind the same URL
    const requests = mockChaingraph({ hasRoot: false })
    expect(await queryIssuingUtxos(tokenId)).toEqual({ output: [tokenOutput] })

    expect(requests.map(request => request.query.includes("unspent_output"))).toEqual([true, false])
  })
})
