import { graphql, ChaingraphClient } from "chaingraph-ts";
import { CHAINGRAPH_URL, TOKENBURNER_LOCKING_BYTECODE } from "@/constants";
import type { AuthchainEntry, BurnEntry, BurnMethod } from "@/interfaces";
import { isBcmrOutput, parseBcmrPublication } from "./bcmr";

const chaingraphClient = new ChaingraphClient(CHAINGRAPH_URL);

export async function queryGenesisInfo(tokenId:string){
  const queryReqGenesisSupply = graphql(`query GenesisSupplyFT (
    $tokenId: bytea
  ) {
      transaction(
        where: {
          inputs: {
            outpoint_transaction_hash: { _eq: $tokenId }
            outpoint_index: { _eq: 0 }
          }
        }
      ) {
        hash
        outputs(where: { token_category: { _eq: $tokenId } }) {
          fungible_token_amount
          nonfungible_token_capability
        }
        block_inclusions {
          block {
            timestamp
          }
        }
      }
    }`);
  const variables = { tokenId: `\\x${tokenId}` }
  return (await chaingraphClient.query(queryReqGenesisSupply, variables)).data
}

export async function queryAllTokenHolders(tokenId:string, offset:number = 0){
  const queryReqTotalSupply = graphql(`query TotalSupplyFT (
    $offset: Int,
    $tokenId: bytea
  ) {
      output(
        offset: $offset
        limit: 5000
        where: {
          token_category: { _eq: $tokenId }
          locking_bytecode_pattern: { _neq: "6a" }
          transaction: { _or: [
            { node_validations: {} },
            { block_inclusions: { block: { accepted_by: {} } } }
            ]
          }
          _not: { spent_by: { 
            transaction: { _or: [
              { node_validations: {} },
              { block_inclusions: { block: { accepted_by: {} } } }
            ] }
          } }
        }
      ) {
        transaction_hash
        output_index
        locking_bytecode
        fungible_token_amount
        nonfungible_token_capability
      }
    }`);
  const variables = { tokenId: `\\x${tokenId}`, offset }
  return (await chaingraphClient.query(queryReqTotalSupply, variables)).data
}

export async function queryIssuingUtxos(tokenId:string){
  const queryReqIssuingUtxos = graphql(`query IssuingUtxos (
    $tokenId: bytea
  ) {
      output(
        where: {
          token_category: { _eq: $tokenId }
          nonfungible_token_capability: { _in: ["minting", "mutable"] }
          locking_bytecode_pattern: { _neq: "6a" }
          transaction: { _or: [
            { node_validations: {} },
            { block_inclusions: { block: { accepted_by: {} } } }
          ] }
          _not: { spent_by: { 
            transaction: { _or: [
              { node_validations: {} },
              { block_inclusions: { block: { accepted_by: {} } } }
            ] }
          } }
        }
      ) {
        transaction_hash
        output_index
        locking_bytecode
        fungible_token_amount
        nonfungible_token_capability
      }
    }`);
  const variables = { tokenId: `\\x${tokenId}` }
  return (await chaingraphClient.query(queryReqIssuingUtxos, variables)).data
}


export async function queryGenesisCategories(txHash:string){
  const queryReqTokenOutputs = graphql(`query TokenOutputs (
    $txHash: bytea
  ) {
    transaction(
      where: {
        hash: {
          _eq: $txHash
        }
        _or: [
          { node_validations: {} },
          { block_inclusions: { block: { accepted_by: {} } } }
        ]
      }
    ) {
      inputs(order_by: { input_index: asc }) {
        outpoint_transaction_hash
        outpoint_index
      }
      outputs(where: { token_category: { _is_null: false } }) {
        token_category
      }
    }
  }`);
  const variables = { txHash: `\\x${txHash}` }
  return (await chaingraphClient.query(queryReqTokenOutputs, variables)).data
}

export async function queryAuthchain(tokenId:string){
  const queryReqAuthHead = graphql(`query Authchain (
    $tokenId: bytea
  ) {
    transaction(
      where: {
        hash: {
          _eq: $tokenId
        }
        _or: [
          { node_validations: {} },
          { block_inclusions: { block: { accepted_by: {} } } }
        ]
      }
    ) {
      hash
      block_inclusions {
        block {
          accepted_by {
            node {
              name
            }
          }
        }
      }
      authchains {
        authhead {
          hash,
          identity_output {
            output_index
            fungible_token_amount
            locking_bytecode
            nonfungible_token_capability
          }
          block_inclusions {
            block {
              timestamp
            }
          }
          outputs {
            output_index
            locking_bytecode
          }
        },
        authchain_length,
        migrations(order_by: { migration_index: asc }) {
          migration_index
          transaction {
            hash
            block_inclusions {
              block {
                timestamp
              }
            }
            outputs {
              output_index
              locking_bytecode
            }
          }
        }
      }
    }
  }`);
  const variables = { tokenId: `\\x${tokenId}` }
  return (await chaingraphClient.query(queryReqAuthHead, variables)).data
}

export type AuthchainQueryResult = Awaited<ReturnType<typeof queryAuthchain>>

/**
 * Turn the authchain migrations from queryAuthchain into AuthchainEntry[] (in
 * migration order), decoding the BCMR publication output where there is one.
 * Includes pre-genesis migrations (the funding tx); callers filter those as needed.
 */
export function parseAuthchainMigrations(result: AuthchainQueryResult): AuthchainEntry[] {
  const migrations = result?.transaction[0]?.authchains?.[0]?.migrations ?? []
  return migrations.map(m => {
    const tx = Array.isArray(m.transaction) ? m.transaction[0] : m.transaction
    const txHash = (tx?.hash ?? '').slice(2)
    const blockTimestamp = tx?.block_inclusions?.[0]?.block?.timestamp
    const timestamp = blockTimestamp ? Number(blockTimestamp) : undefined
    const bcmrOutput = tx?.outputs?.find(output => isBcmrOutput(output.locking_bytecode?.slice(2) ?? ''))
    const opReturnHex = bcmrOutput?.locking_bytecode?.slice(2)
    const publication = opReturnHex ? parseBcmrPublication(opReturnHex) : undefined
    return { txHash, timestamp, isMetadataUpdate: !!bcmrOutput, opReturnHex, publication }
  })
}

// Chaingraph caps `output` at 5000 rows per query
const BURN_PAGE_SIZE = 5000

/**
 * Token outputs of the category whose locking bytecode starts with OP_RETURN. They are
 * unspendable, so no spent/unspent filter is needed. Rows include transactions that
 * never confirmed (e.g. lost a double-spend race), see parseBurnRows.
 */
export async function queryOpReturnTokenOutputs(tokenId:string, offset:number = 0){
  const queryReqOpReturnOutputs = graphql(`query OpReturnTokenOutputs (
    $offset: Int,
    $tokenId: bytea
  ) {
      output(
        offset: $offset
        limit: 5000
        order_by: [{ transaction_hash: asc }, { output_index: asc }]
        where: {
          token_category: { _eq: $tokenId }
          locking_bytecode_pattern: { _like: "6a%" }
        }
      ) {
        transaction_hash
        output_index
        fungible_token_amount
        nonfungible_token_capability
        transaction {
          node_validations(limit: 1) {
            validated_at
          }
          block_inclusions {
            block {
              timestamp
            }
          }
        }
      }
    }`);
  const variables = { tokenId: `\\x${tokenId}`, offset }
  return (await chaingraphClient.query(queryReqOpReturnOutputs, variables)).data
}

/** All outputs of the category ever sent to the burner contract, spent (swept) or not; see parseBurnRows. */
export async function queryTokenburnerOutputs(tokenId:string, offset:number = 0){
  const queryReqTokenburnerOutputs = graphql(`query TokenburnerOutputs (
    $offset: Int,
    $tokenId: bytea,
    $lockingBytecode: bytea
  ) {
      output(
        offset: $offset
        limit: 5000
        order_by: [{ transaction_hash: asc }, { output_index: asc }]
        where: {
          token_category: { _eq: $tokenId }
          locking_bytecode: { _eq: $lockingBytecode }
        }
      ) {
        transaction_hash
        output_index
        fungible_token_amount
        nonfungible_token_capability
        transaction {
          node_validations(limit: 1) {
            validated_at
          }
          block_inclusions {
            block {
              timestamp
            }
          }
        }
      }
    }`);
  const variables = { tokenId: `\\x${tokenId}`, offset, lockingBytecode: `\\x${TOKENBURNER_LOCKING_BYTECODE}` }
  return (await chaingraphClient.query(queryReqTokenburnerOutputs, variables)).data
}

export type BurnOutputRow = NonNullable<Awaited<ReturnType<typeof queryOpReturnTokenOutputs>>>['output'][number]

async function fetchAllPages(
  queryPage: (offset: number) => Promise<{ output: BurnOutputRow[] } | undefined>,
  label: string
): Promise<BurnOutputRow[]> {
  let rows: BurnOutputRow[] = []
  for (let offset = 0; ; offset += BURN_PAGE_SIZE) {
    const page = await queryPage(offset)
    if (!page) throw new Error(`${label} returned no data (offset ${offset})`)
    rows = rows.concat(page.output)
    if (page.output.length < BURN_PAGE_SIZE) return rows
  }
}

/**
 * Turn burn-query rows into BurnEntry[]. Chaingraph keeps transactions it once saw in a
 * mempool even after they were dropped (ParyonUSD has 14 such double-spent OP_RETURN
 * outputs), so a row only counts if its transaction is in a mempool now or in a block. The
 * usual server-side filter (node_validations or a block with accepted_by) makes these queries
 * time out on large categories, and selecting the block's accepted_by is what's slow, so a
 * block inclusion is taken as-is: only a transaction mined solely in an orphaned block slips through.
 */
export function parseBurnRows(rows: BurnOutputRow[], method: BurnMethod): BurnEntry[] {
  return rows.flatMap(row => {
    const tx = row.transaction
    if (!tx || (tx.node_validations.length === 0 && tx.block_inclusions.length === 0)) return []
    const blockTimestamp = tx.block_inclusions[0]?.block.timestamp
    return [{
      txHash: row.transaction_hash.slice(2),
      vout: Number(row.output_index),
      method,
      fungibleTokenAmount: BigInt(row.fungible_token_amount ?? '0'),
      nftCapability: row.nonfungible_token_capability ?? null,
      timestamp: blockTimestamp ? Number(blockTimestamp) : undefined,
    }]
  })
}

/** Provable burns of the category: OP_RETURN token outputs plus burner-contract outputs (all pages of both). */
export async function queryKnownBurns(tokenId:string): Promise<BurnEntry[]> {
  const [opReturnRows, tokenburnerRows] = await Promise.all([
    fetchAllPages(offset => queryOpReturnTokenOutputs(tokenId, offset), 'queryOpReturnTokenOutputs'),
    fetchAllPages(offset => queryTokenburnerOutputs(tokenId, offset), 'queryTokenburnerOutputs'),
  ])
  return [...parseBurnRows(opReturnRows, 'op_return'), ...parseBurnRows(tokenburnerRows, 'tokenburner')]
}
