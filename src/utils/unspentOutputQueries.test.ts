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
}

interface GraphqlRequest {
  query: string
  variables: Record<string, unknown>
}

// Stands in for a Chaingraph instance over HTTP; `hasRoot` decides how it answers
function mockChaingraph({ hasRoot }: { hasRoot: boolean }) {
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
      body = { data: { output: [tokenOutput] } }
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

    expect(await queryAllTokenHolders(tokenId, 5000)).toEqual({ output: [tokenOutput] })
    expect(await queryIssuingUtxos(tokenId)).toEqual({ output: [tokenOutput] })

    const [check, holders, issuing] = requests
    expect(requests).toHaveLength(3)
    expect(check?.query).toContain("query ChaingraphCapabilities")
    expect(holders?.query).toContain("output: unspent_output(")
    expect(holders?.variables).toEqual({ tokenId: `\\x${tokenId}`, offset: 5000, node: "bchn-mainnet" })
    expect(issuing?.query).toContain("IssuingUtxosUnspent")
  })

  it("send the generic query when the instance doesn't have unspent_output", async () => {
    const requests = mockChaingraph({ hasRoot: false })

    expect(await queryAllTokenHolders(tokenId)).toEqual({ output: [tokenOutput] })

    const [, holders] = requests
    expect(requests).toHaveLength(2)
    expect(holders?.query).toContain("spent_by")
    expect(holders?.query).not.toContain("unspent_output")
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
