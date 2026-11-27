/*
  Reading the unspent outputs of a token category.

  Instances running the ParyonUSD/chaingraph fork have an `unspent_output(node_name)` query root. It
  returns the outputs that the named node sees as unspent: created by a transaction the node accepts
  (in a block or in its mempool) and not spent by any transaction it accepts. Filtered on
  `token_category`, it answers in milliseconds where the generic `output` query with a
  `_not: { spent_by }` filter takes seconds, or times out for tokens with many outputs.

  Other instances don't have the root, and the instance behind one URL can change (the URL may be
  moved to another instance), so the explorer checks what the instance offers and falls back to the
  generic query:
  - The check (query root fields and node names, one request) is cached per endpoint URL and redone
    after RECHECK_AFTER_MS, so a switch to an instance with the root is picked up.
  - A query rejected because `unspent_output` doesn't exist marks the endpoint as without the root and
    runs the generic query instead, so a switch to an instance without the root costs one failed request.
  - A failed generic query clears the cached check, so the next query checks again.
  - A failed check is not cached; the query uses the generic query and the next one checks again.

  The node is the one that accepts the token's category transaction (the transaction whose hash is the
  token id). An instance with a single node needs no lookup. When no node accepts it, the explorer uses
  the generic query, which accepts a transaction seen by any node. Node lookups belong to one check, so
  they are redone with it. `unspent_output` returns no rows for a node name the instance doesn't have,
  so each `unspent_output` query also reads the instance's nodes (CHAINGRAPH_NODES_FIELD); if the node
  isn't there, the instance has changed, and the query runs again with the generic version.

  Paging (readUnspentOutputs): a paged query is read as one scan, with one query version and one node.
  Pages are ordered by the creating transaction's `internal_id` (the order this instance stored
  transactions in), then `output_index`, and each page asks for the outputs after the last one read
  (AFTER_OUTPUT). An output joining or leaving the set behind that position doesn't move the outputs
  still to be read, and a newly created output has a higher `internal_id`, so it comes after it.
  `internal_id` means something only on one instance, so every page also reads the instance's nodes, and
  a scan that sees them change, or has to switch to the generic version, starts again from the beginning.
  A scan is not a snapshot: if a token moves while it runs, the old output may already have been read
  and the new one is read later, so that amount is counted twice. Only tokens with more than one page of
  unspent outputs are affected.
*/

export const UNSPENT_OUTPUT_ROOT = "unspent_output"
export const RECHECK_AFTER_MS = 5 * 60_000

/**
 * Root field for every `unspent_output` document and every paged document: the instance's nodes. The
 * connection times tell two instances apart even when one was restored from the other's snapshot.
 */
export const CHAINGRAPH_NODES_FIELD =
  "chaingraph_nodes: node(order_by: { internal_id: asc }) { name internal_id first_connected_at latest_connection_began_at }"

export interface ChaingraphNodesData {
  chaingraph_nodes: { name: string }[]
}

/** Where a page starts: after this output, in (`transaction.internal_id`, `output_index`) order. */
export interface OutputCursor {
  internalId: string
  outputIndex: string
}

/**
 * The `where` condition for the outputs after `cursor`, passed as the `$after: output_bool_exp!` variable.
 * The first page passes `{}`: through the `transaction` relationship the condition costs something for
 * every candidate output, even when it is always true.
 */
export function outputsAfter(cursor: OutputCursor | undefined): Record<string, unknown> {
  if (!cursor) return {}
  return {
    _or: [
      { transaction: { internal_id: { _gt: cursor.internalId } } },
      { transaction: { internal_id: { _eq: cursor.internalId } }, output_index: { _gt: cursor.outputIndex } },
    ],
  }
}

/** Order for paged documents, matching outputsAfter. */
export const OUTPUT_KEY_ORDER = "[{ transaction: { internal_id: asc } }, { output_index: asc }]"

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
  /** Node per token id, found with these capabilities; small, because the explorer looks at one token at a time */
  nodeNameByToken: Map<string, Promise<string | undefined>>
}

const MAX_CACHED_NODE_LOOKUPS = 50

const capabilitiesByEndpoint = new Map<string, CachedCapabilities>()

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

function checkCapabilities(endpoint: string, runQuery: ChaingraphQueryRunner): CachedCapabilities {
  const cached = capabilitiesByEndpoint.get(endpoint)
  if (cached && Date.now() - cached.checkedAt < RECHECK_AFTER_MS) return cached

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
  const entry = { checkedAt: Date.now(), capabilities, nodeNameByToken: new Map<string, Promise<string | undefined>>() }
  capabilitiesByEndpoint.set(endpoint, entry)
  return entry
}

function markWithoutUnspentOutputRoot(endpoint: string) {
  capabilitiesByEndpoint.set(endpoint, {
    checkedAt: Date.now(),
    capabilities: Promise.resolve({ hasUnspentOutputRoot: false, nodeNames: [] }),
    nodeNameByToken: new Map(),
  })
}

/** Clears what is known about every endpoint (used by tests). */
export function forgetChaingraphCapabilities() {
  capabilitiesByEndpoint.clear()
}

function findNodeName(
  entry: CachedCapabilities,
  tokenId: string,
  nodeNames: string[],
  runQuery: ChaingraphQueryRunner
): Promise<string | undefined> {
  if (nodeNames.length === 1) return Promise.resolve(nodeNames[0])
  if (nodeNames.length === 0) return Promise.resolve(undefined)

  const cache = entry.nodeNameByToken
  const cached = cache.get(tokenId)
  if (cached) return cached

  const lookUp = async () => {
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
  }
  // Only a found node stays cached: an unknown or brand-new transaction, or a failed lookup, is looked up again next time
  const nodeName: Promise<string | undefined> = lookUp().then(
    found => {
      if (found === undefined && cache.get(tokenId) === nodeName) cache.delete(tokenId)
      return found
    },
    (error: unknown) => {
      if (cache.get(tokenId) === nodeName) cache.delete(tokenId)
      console.warn(`Could not find the node for token ${tokenId}; using the generic query.`, error)
      return undefined
    }
  )

  if (cache.size >= MAX_CACHED_NODE_LOOKUPS) {
    const oldestTokenId = cache.keys().next().value
    if (oldestTokenId !== undefined) cache.delete(oldestTokenId)
  }
  cache.set(tokenId, nodeName)
  return nodeName
}

// Hasura's validation error for a query naming a root field the instance doesn't have:
// "field 'unspent_output' not found in type: 'query_root'"
function isMissingUnspentOutputRoot(error: { message: string } | undefined) {
  return !!error && error.message.includes(UNSPENT_OUTPUT_ROOT) && /not found|no such|unexpected/i.test(error.message)
}

/** A row of a paged document: it selects `transaction { internal_id }` for the cursor. */
export interface KeyedOutput {
  output_index: string
  transaction?: { internal_id: string } | null
}

export interface UnspentOutputsRead<Row extends KeyedOutput> {
  endpoint: string
  tokenId: string
  runQuery: ChaingraphQueryRunner
  /** Rows per page of a paged query; without it the query is read once. A paged generic document has CHAINGRAPH_NODES_FIELD. */
  pageSize?: number
  /** Checked between pages: a superseded scan stops and returns neither data nor error. */
  isCurrent?: () => boolean
  /** Reads a page through `unspent_output` for the given node, with CHAINGRAPH_NODES_FIELD in the document. */
  readWithRoot: (nodeName: string, after: OutputCursor | undefined) => Promise<ChaingraphQueryResult<{ output: Row[] } & ChaingraphNodesData>>
  /** Reads a page through the generic `output` query. */
  readWithoutRoot: (after: OutputCursor | undefined) => Promise<ChaingraphQueryResult<{ output: Row[] } & Partial<ChaingraphNodesData>>>
}

type ScanOutcome<Row> =
  | { kind: "rows", rows: Row[] }
  | { kind: "error", error: { message: string } }
  | { kind: "superseded" }
  | { kind: "use generic query" }
  | { kind: "instance changed" }

// A scan starts again when the instance changes under it; past this many attempts the read fails
const MAX_SCAN_ATTEMPTS = 3

/**
 * Reads all unspent outputs of a token category, through `unspent_output` when the endpoint has it, else
 * the generic query, as one scan with one version and one node (see the comment at the top).
 */
export async function readUnspentOutputs<Row extends KeyedOutput>(read: UnspentOutputsRead<Row>): Promise<ChaingraphQueryResult<{ output: Row[] }>> {
  const { endpoint, tokenId, runQuery, pageSize, isCurrent = () => true } = read
  let mayUseRoot = true
  for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt++) {
    const entry = checkCapabilities(endpoint, runQuery)
    const capabilities = await entry.capabilities
    const nodeName = mayUseRoot && capabilities.hasUnspentOutputRoot
      ? await findNodeName(entry, tokenId, capabilities.nodeNames, runQuery)
      : undefined
    const outcome = await scan(read, entry, nodeName, pageSize, isCurrent)
    switch (outcome.kind) {
      case "rows": return { data: { output: outcome.rows } }
      case "error": return { error: outcome.error }
      case "superseded": return {}
      // The rest of this read uses the generic version, even if a new check says otherwise
      case "use generic query": mayUseRoot = false; break
      case "instance changed": break
    }
  }
  return { error: { message: `the Chaingraph instance at ${endpoint} changed during each of ${MAX_SCAN_ATTEMPTS} reads` } }
}

async function scan<Row extends KeyedOutput>(
  read: UnspentOutputsRead<Row>,
  entry: CachedCapabilities,
  nodeName: string | undefined,
  pageSize: number | undefined,
  isCurrent: () => boolean
): Promise<ScanOutcome<Row>> {
  const { endpoint } = read
  // Drops the cached check (unless a newer one replaced it), so the next read checks the instance again
  const forgetCheck = () => { if (capabilitiesByEndpoint.get(endpoint) === entry) capabilitiesByEndpoint.delete(endpoint) }
  let rows: Row[] = []
  let cursor: OutputCursor | undefined
  let instanceNodes: string | undefined
  for (;;) {
    if (cursor && !isCurrent()) return { kind: "superseded" }
    const result = nodeName ? await read.readWithRoot(nodeName, cursor) : await read.readWithoutRoot(cursor)
    if (!result.data) {
      if (nodeName && isMissingUnspentOutputRoot(result.error)) {
        console.warn(`${endpoint} no longer has ${UNSPENT_OUTPUT_ROOT}; using the generic query.`)
        markWithoutUnspentOutputRoot(endpoint)
        return { kind: "use generic query" }
      }
      // A failed generic query may mean the instance changed
      if (!nodeName) forgetCheck()
      return { kind: "error", error: result.error ?? { message: "no data received" } }
    }
    const nodes = result.data.chaingraph_nodes
    if (nodeName && !nodes?.some(node => node.name === nodeName)) {
      // The instance behind the URL doesn't have this node (its rows would all be missing)
      console.warn(`${endpoint} has no node ${nodeName}; using the generic query.`)
      forgetCheck()
      return { kind: "use generic query" }
    }
    const pageInstanceNodes = JSON.stringify(nodes)
    if (instanceNodes !== undefined && pageInstanceNodes !== instanceNodes) {
      console.warn(`The Chaingraph instance at ${endpoint} changed while reading; reading again from the start.`)
      forgetCheck()
      return { kind: "instance changed" }
    }
    instanceNodes = pageInstanceNodes
    rows = rows.concat(result.data.output)
    const lastRow = result.data.output.at(-1)
    if (pageSize === undefined || result.data.output.length < pageSize || !lastRow) return { kind: "rows", rows }
    if (!lastRow.transaction) return { kind: "error", error: { message: "a paged row has no transaction internal_id" } }
    cursor = { internalId: lastRow.transaction.internal_id, outputIndex: lastRow.output_index }
  }
}
