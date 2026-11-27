/*
  Reading the unspent outputs of a token category.

  Some Chaingraph instances (the ParyonUSD fork) have an `unspent_output(node_name)` query root. It
  returns the outputs that the named node sees as unspent: created by a transaction the node accepts
  (in a block or in its mempool) and not spent by any transaction it accepts. Filtered on
  `token_category`, it answers in milliseconds where the generic `output` query with a
  `_not: { spent_by }` filter takes seconds, or times out for tokens with many outputs.

  Other instances don't have the root, and the instance behind one URL can change (for example after
  a DNS switch), so the explorer checks what the instance offers and falls back to the generic query:
  - The check (query root fields and node names, one request) is cached per endpoint URL and redone
    after RECHECK_AFTER_MS, so a switch to an instance with the root is picked up.
  - A query rejected because `unspent_output` doesn't exist marks the endpoint as without the root and
    runs the generic query instead, so a switch to an instance without the root costs one failed request.
  - A failed generic query clears the cached check, so the next query checks again.
  - A failed check is not cached; the query uses the generic query and the next one checks again.

  The node is the one that accepts the token's category transaction (the transaction whose hash is the
  token id). An instance with a single node needs no lookup. When no node accepts it, the explorer uses
  the generic query, which accepts a transaction seen by any node.
*/

export const UNSPENT_OUTPUT_ROOT = "unspent_output"
export const RECHECK_AFTER_MS = 5 * 60_000

export interface ChaingraphQueryResult<Data> {
  data?: Data
  error?: { message: string }
}

/** Runs one GraphQL document (as text) against the endpoint. */
export type ChaingraphQueryRunner = <Data>(
  document: string,
  variables: Record<string, unknown>
) => Promise<ChaingraphQueryResult<Data>>

interface ChaingraphCapabilities {
  hasUnspentOutputRoot: boolean
  nodeNames: string[]
}

interface CachedCapabilities {
  checkedAt: number
  capabilities: Promise<ChaingraphCapabilities>
}

const capabilitiesByEndpoint = new Map<string, CachedCapabilities>()

// Node name per endpoint and token id; small, because the explorer looks at one token at a time
const MAX_CACHED_NODE_LOOKUPS = 50
const nodeNameByEndpointAndToken = new Map<string, Promise<string | undefined>>()

const queryCapabilities = `query ChaingraphCapabilities {
  node {
    name
  }
  __type(name: "query_root") {
    fields {
      name
    }
  }
}`

interface CapabilitiesData {
  node: { name: string }[]
  __type: { fields: { name: string }[] | null } | null
}

const queryNodesAcceptingTransaction = `query NodesAcceptingTransaction (
  $hash: bytea
) {
  transaction(where: { hash: { _eq: $hash } }) {
    node_validations {
      node {
        name
      }
    }
    block_inclusions {
      block {
        accepted_by {
          node {
            name
          }
        }
      }
    }
  }
}`

interface NodesAcceptingTransactionData {
  transaction: {
    node_validations: { node: { name: string } }[]
    block_inclusions: { block: { accepted_by: { node: { name: string } }[] } }[]
  }[]
}

function checkCapabilities(endpoint: string, runQuery: ChaingraphQueryRunner): Promise<ChaingraphCapabilities> {
  const cached = capabilitiesByEndpoint.get(endpoint)
  if (cached && Date.now() - cached.checkedAt < RECHECK_AFTER_MS) return cached.capabilities

  const capabilities = (async () => {
    const result = await runQuery<CapabilitiesData>(queryCapabilities, {})
    if (result.error || !result.data) throw new Error(result.error?.message ?? "no data received")
    const rootFields = result.data.__type?.fields ?? []
    return {
      hasUnspentOutputRoot: rootFields.some(field => field.name === UNSPENT_OUTPUT_ROOT),
      nodeNames: result.data.node.map(node => node.name),
    }
  })().catch(error => {
    // Don't cache a failed check (unless a newer check already replaced it); the next query checks again
    if (capabilitiesByEndpoint.get(endpoint)?.capabilities === capabilities) capabilitiesByEndpoint.delete(endpoint)
    console.warn(`Could not check whether ${endpoint} has ${UNSPENT_OUTPUT_ROOT}; using the generic query.`, error)
    return { hasUnspentOutputRoot: false, nodeNames: [] }
  })
  capabilitiesByEndpoint.set(endpoint, { checkedAt: Date.now(), capabilities })
  return capabilities
}

function markWithoutUnspentOutputRoot(endpoint: string) {
  capabilitiesByEndpoint.set(endpoint, {
    checkedAt: Date.now(),
    capabilities: Promise.resolve({ hasUnspentOutputRoot: false, nodeNames: [] }),
  })
}

/** Clears what is known about every endpoint (used by tests). */
export function forgetChaingraphCapabilities() {
  capabilitiesByEndpoint.clear()
  nodeNameByEndpointAndToken.clear()
}

function findNodeName(
  endpoint: string,
  tokenId: string,
  nodeNames: string[],
  runQuery: ChaingraphQueryRunner
): Promise<string | undefined> {
  if (nodeNames.length === 1) return Promise.resolve(nodeNames[0])
  if (nodeNames.length === 0) return Promise.resolve(undefined)

  const cacheKey = `${endpoint} ${tokenId}`
  const cached = nodeNameByEndpointAndToken.get(cacheKey)
  if (cached) return cached

  const nodeName = (async () => {
    const result = await runQuery<NodesAcceptingTransactionData>(queryNodesAcceptingTransaction, { hash: `\\x${tokenId}` })
    if (result.error || !result.data) throw new Error(result.error?.message ?? "no data received")
    const acceptingNodes = new Set<string>()
    for (const transaction of result.data.transaction) {
      for (const validation of transaction.node_validations) acceptingNodes.add(validation.node.name)
      for (const inclusion of transaction.block_inclusions) {
        for (const acceptance of inclusion.block.accepted_by) acceptingNodes.add(acceptance.node.name)
      }
    }
    // Several accepting nodes (for example two mainnet nodes): take the first by name, so the choice is stable
    return nodeNames.filter(name => acceptingNodes.has(name)).sort()[0]
  })().catch(error => {
    nodeNameByEndpointAndToken.delete(cacheKey)
    console.warn(`Could not find the node for token ${tokenId}; using the generic query.`, error)
    return undefined
  })

  if (nodeNameByEndpointAndToken.size >= MAX_CACHED_NODE_LOOKUPS) {
    const oldestKey = nodeNameByEndpointAndToken.keys().next().value
    if (oldestKey !== undefined) nodeNameByEndpointAndToken.delete(oldestKey)
  }
  nodeNameByEndpointAndToken.set(cacheKey, nodeName)
  return nodeName
}

// Hasura's validation error for a query naming a root field the instance doesn't have:
// "field 'unspent_output' not found in type: 'query_root'"
function isMissingUnspentOutputRoot(error: { message: string } | undefined) {
  return !!error && error.message.includes(UNSPENT_OUTPUT_ROOT) && /not found|no such|unexpected/i.test(error.message)
}

export interface UnspentOutputsRead<Data> {
  endpoint: string
  tokenId: string
  runQuery: ChaingraphQueryRunner
  /** Reads through `unspent_output` for the given node. */
  readWithRoot: (nodeName: string) => Promise<ChaingraphQueryResult<Data>>
  /** Reads through the generic `output` query. */
  readWithoutRoot: () => Promise<ChaingraphQueryResult<Data>>
}

/** Reads unspent outputs of a token category through `unspent_output` when the endpoint has it, else the generic query. */
export async function readUnspentOutputs<Data>(read: UnspentOutputsRead<Data>): Promise<ChaingraphQueryResult<Data>> {
  const { endpoint, tokenId, runQuery } = read
  const capabilities = await checkCapabilities(endpoint, runQuery)
  if (capabilities.hasUnspentOutputRoot) {
    const nodeName = await findNodeName(endpoint, tokenId, capabilities.nodeNames, runQuery)
    if (nodeName) {
      const result = await read.readWithRoot(nodeName)
      if (!isMissingUnspentOutputRoot(result.error)) return result
      console.warn(`${endpoint} no longer has ${UNSPENT_OUTPUT_ROOT}; using the generic query.`)
      markWithoutUnspentOutputRoot(endpoint)
    }
  }
  const result = await read.readWithoutRoot()
  // A failed generic query may mean the instance changed; check again on the next query
  if (result.error) capabilitiesByEndpoint.delete(endpoint)
  return result
}
