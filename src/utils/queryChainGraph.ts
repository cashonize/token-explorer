import { graphql, ChaingraphClient } from "chaingraph-ts";
import { CHAINGRAPH_URL } from "@/constants";
import { readUnspentOutputs, type ChaingraphQueryRunner } from "./unspentOutputRoot";

const chaingraphClient = new ChaingraphClient(CHAINGRAPH_URL);

const runQuery: ChaingraphQueryRunner = async (document, variables) =>
  await chaingraphClient.query(document, variables)

// Result shape shared by the generic `output` queries and their `unspent_output` versions below
export interface UnspentTokenOutput {
  transaction_hash: string
  output_index: string
  locking_bytecode: string
  fungible_token_amount: string | null
  nonfungible_token_capability: "none" | "mutable" | "minting" | null
}

interface UnspentTokenOutputs {
  output: UnspentTokenOutput[]
}

// The `unspent_output` versions are plain strings: the chaingraph-ts schema types don't include that root.
// Aliasing it as `output` keeps the result shape of the generic queries.
const queryTotalSupplyFromUnspentOutputs = `query TotalSupplyFTUnspent (
  $offset: Int,
  $tokenId: bytea,
  $node: String!
) {
    output: unspent_output(
      args: { node_name: $node }
      offset: $offset
      limit: 5000
      where: {
        token_category: { _eq: $tokenId }
        locking_bytecode_pattern: { _neq: "6a" }
      }
    ) {
      transaction_hash
      output_index
      locking_bytecode
      fungible_token_amount
      nonfungible_token_capability
    }
  }`

const queryIssuingUtxosFromUnspentOutputs = `query IssuingUtxosUnspent (
  $tokenId: bytea,
  $node: String!
) {
    output: unspent_output(
      args: { node_name: $node }
      where: {
        token_category: { _eq: $tokenId }
        nonfungible_token_capability: { _in: ["minting", "mutable"] }
        locking_bytecode_pattern: { _neq: "6a" }
      }
    ) {
      transaction_hash
      output_index
      locking_bytecode
      fungible_token_amount
      nonfungible_token_capability
    }
  }`

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
  const result = await readUnspentOutputs<UnspentTokenOutputs>({
    endpoint: CHAINGRAPH_URL,
    tokenId,
    runQuery,
    readWithRoot: (node) => runQuery(queryTotalSupplyFromUnspentOutputs, { ...variables, node }),
    readWithoutRoot: async () => await chaingraphClient.query(queryReqTotalSupply, variables),
  })
  return result.data
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
  const result = await readUnspentOutputs<UnspentTokenOutputs>({
    endpoint: CHAINGRAPH_URL,
    tokenId,
    runQuery,
    readWithRoot: (node) => runQuery(queryIssuingUtxosFromUnspentOutputs, { ...variables, node }),
    readWithoutRoot: async () => await chaingraphClient.query(queryReqIssuingUtxos, variables),
  })
  return result.data
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