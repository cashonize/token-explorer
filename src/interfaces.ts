import { z } from 'zod/v4'
import { IdentitySnapshotSchema, NftCategorySchema } from './utils/bcmrSchema'
import type { BcmrPublication } from './utils/bcmr'

export type TokenMetadata = z.infer<typeof IdentitySnapshotSchema>
export type NftCategory = z.infer<typeof NftCategorySchema>

export interface AuthchainEntry {
  txHash: string
  timestamp?: number
  isMetadataUpdate: boolean
  opReturnHex?: string
  /** decoded BCMR publication output, if the migration has a well-formed one */
  publication?: BcmrPublication
}

export interface ReservedSupplyUtxo {
  txHash: string
  vout: number
  lockingBytecode: string
  fungibleTokenAmount: bigint
  nftCapability: 'minting' | 'mutable' | null
  isAuthhead?: boolean
}

/** 'op_return': a token output with an OP_RETURN locking bytecode (unspendable);
 * 'tokenburner': an output sent to the tokenburner.cash burner contract */
export type BurnMethod = 'op_return' | 'tokenburner'

export interface BurnEntry {
  txHash: string
  vout: number
  method: BurnMethod
  fungibleTokenAmount: bigint
  nftCapability: 'none' | 'mutable' | 'minting' | null
  /** block timestamp, undefined while unconfirmed */
  timestamp?: number
}

export interface KnownBurns {
  burnedFT: bigint
  burnedNFTs: number
  /** latest first (unconfirmed before confirmed) */
  burns: BurnEntry[]
}

export interface TokenInfo {
  genesisSupplyFT: bigint
  hasGenesisNFTs: boolean
  genesisTxTimestamp: number | undefined
  hasActiveMintingToken: boolean
  reservedSupplyUtxos: ReservedSupplyUtxo[]
  reservedSupplyFT: bigint
  genesisTx: string
  authchainLength?: number
  authHead?: string
  authHeadAddress?: string
  authHeadTimestamp?: number
  authHeadIsMetadataUpdate?: boolean
  authHeadBurned?: boolean
  usesAuthGuard?: boolean
  network: 'mainnet' | 'chipnet'
  authchainMigrations?: AuthchainEntry[]
  validTxId: boolean
  validTokenCategory: boolean
  tokenCategoriesInTx?: string[]
  genesisInfoError?: string
  issuingUtxosError?: string
  /** provable burns (OP_RETURN outputs and the tokenburner.cash contract), merged in after Phase 1;
   *  undefined while loading or when the query failed (then burnsError is set) */
  knownBurns?: KnownBurns
  burnsError?: string
}

export interface ExtendedTokenInfo {
  totalSupplyFT: bigint
  totalSupplyNFTs: number
  numberHolders: number
  numberTokenAddresses: number
  userSupplyFT: bigint
  contractSupplyFT: bigint
}

export type DiagnosticType =
  | 'fetch_failed'      // CORS, network error, server down
  | 'http_error'        // Non-2xx HTTP status (403 Cloudflare, 404, 500...)
  | 'invalid_json'      // Server returned non-JSON (HTML error page, Cloudflare challenge)
  | 'schema_invalid'    // Zod validation failed — detail lists specific issues
  | 'hash_mismatch'     // On-chain hash doesn't match fetched content
  | 'unresolvable_publication' // Latest BCMR output is malformed or has no fetchable URI

export interface Diagnostic {
  type: DiagnosticType
  message: string
  details?: string
}

export interface ElectrumVerification {
  verified: boolean
  totalChaingraphUtxos: number
  totalElectrumUtxos: number
  staleCount: number
  missingCount: number
  chaingraphTotalFT: bigint
  electrumTotalFT: bigint
  electrumReservedFT: bigint
  authHeadUnspent?: boolean
  error?: string
}

export interface MetadataInfo {
  metaDataLocation?:string;
  httpsUrl?:string;
  authchainUpdates?: number

  tokenMetadata?: TokenMetadata | undefined
  metadataHashMatch?: boolean
  isOtrVerified?: boolean
  isSchemaValid?: boolean
  diagnostics?: Diagnostic[]
}
