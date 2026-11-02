import { binToHex, binToUtf8, decodeAuthenticationInstructions, hexToBin, sha256 } from '@bitauth/libauth'
import { IPFS_GATEWAY } from '@/constants'
import { IdentitySnapshotSchema } from './bcmrSchema'
import { ipfsToGatewayUrl } from './utils'
import type { Diagnostic, TokenMetadata } from '@/interfaces'

// BCMR implementation (CHIP-BCMR v2), see https://github.com/bitjson/chip-bcmr
// Covers what the explorer needs: decoding publication outputs, resolving their URIs,
// fetching + hash-verifying the registry, and selecting the current identity snapshot.

// The spec defines a publication output as starting with exactly OP_RETURN OP_PUSHBYTES_4 'BCMR'
const BCMR_OUTPUT_PREFIX = '6a0442434d52'
const WELL_KNOWN_PATH = '/.well-known/bitcoin-cash-metadata-registry.json'

export function isBcmrOutput(lockingBytecodeHex: string): boolean {
  return lockingBytecodeHex.toLowerCase().startsWith(BCMR_OUTPUT_PREFIX)
}

/**
 * Decode the data pushes following OP_RETURN, as hex strings.
 * Non-push opcodes are skipped; decoding stops at a malformed (truncated) push.
 */
export function parseOpReturnPushes(lockingBytecodeHex: string): string[] {
  const instructions = decodeAuthenticationInstructions(hexToBin(lockingBytecodeHex))
  const pushes: string[] = []
  for (const instruction of instructions) {
    if ('malformed' in instruction && instruction.malformed) break
    if ('data' in instruction) pushes.push(binToHex(instruction.data))
  }
  return pushes
}

export interface BcmrPublication {
  /** sha256 of the registry content as committed on-chain (for a CID-only publication: the CID bytes) */
  contentHash: string
  /** the URIs as published (for a CID-only publication: the derived ipfs:// URI) */
  uris: string[]
  /** HTTPS URL resolved from the first resolvable URI, or "" if none */
  httpsUrl: string
  /** the URI that httpsUrl was resolved from */
  resolvedUri: string
  /**
   * true for the non-spec form OP_RETURN <'BCMR'> <IPFS CID> (a convention from mainnet-js):
   * the push after 'BCMR' is a UTF-8 CID instead of a sha256, and there are no URI pushes
   */
  isCidOnly: boolean
}

/**
 * Resolve a BCMR publication URI to an HTTPS URL, per the spec:
 * - ipfs://<cid> goes through the configured IPFS gateway
 * - URIs without a protocol are assumed to be HTTPS
 * - a domain without a path resolves to its /.well-known/bitcoin-cash-metadata-registry.json
 * Returns undefined for other protocols (e.g. http://), which can't be fetched safely.
 */
export function resolveBcmrUri(uri: string, ipfsGateway: string = IPFS_GATEWAY): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1]?.toLowerCase()
  if (scheme === 'ipfs') return ipfsToGatewayUrl(uri, ipfsGateway)
  if (scheme !== undefined && scheme !== 'https') return undefined

  let url: URL
  try {
    url = new URL(scheme ? uri : `https://${uri}`)
  } catch {
    return undefined
  }
  const hasPath = url.pathname !== '/' || url.search !== '' || url.hash !== ''
  // an IPFS subdomain gateway host like <cid>.ipfs.<gateway> serves the content at its root
  const [firstLabel, secondLabel] = url.hostname.split('.')
  const isIpfsSubdomainHost = firstLabel?.startsWith('baf') && secondLabel === 'ipfs'
  if (!hasPath && !isIpfsSubdomainHost) return url.origin + WELL_KNOWN_PATH
  return url.href
}

/**
 * Decode a BCMR publication output: OP_RETURN <'BCMR'> <sha256> <uri>...
 * Returns undefined if the output is not a well-formed BCMR publication.
 */
export function parseBcmrPublication(lockingBytecodeHex: string): BcmrPublication | undefined {
  if (!isBcmrOutput(lockingBytecodeHex)) return undefined
  const pushes = parseOpReturnPushes(lockingBytecodeHex)
  const [, hashPush, ...uriPushes] = pushes
  if (hashPush === undefined) return undefined

  // A spec-conforming publication without URIs commits to a sha256 that is meant to be
  // resolved by content addressing, which we can't do. mainnet-js-era tooling instead put
  // a UTF-8 IPFS CID in this push; recognise that form so those registries still resolve.
  const hashPushUtf8 = uriPushes.length === 0 ? binToUtf8(hexToBin(hashPush)) : ''
  const isCidOnly = /^(baf[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(hashPushUtf8)
  const uris = isCidOnly
    ? [`ipfs://${hashPushUtf8}`]
    : uriPushes.map(push => binToUtf8(hexToBin(push)))

  let httpsUrl = ''
  let resolvedUri = ''
  for (const uri of uris) {
    const resolved = resolveBcmrUri(uri)
    if (resolved) {
      httpsUrl = resolved
      resolvedUri = uri
      break
    }
  }

  return { contentHash: hashPush, uris, httpsUrl, resolvedUri, isCidOnly }
}

/**
 * Select the current snapshot from an identity history, per the spec: the one with the
 * latest timestamp that has been reached; if none has been reached yet, the oldest one.
 * Falls back to the first listed snapshot when no key is an ISO timestamp, so malformed
 * registries still show something.
 */
export function getCurrentSnapshot(identityHistory: Record<string, unknown>, now: number = Date.now()): unknown {
  const timestamps = Object.keys(identityHistory)
    .filter(key => /^\d{4}-\d{2}-\d{2}(T|$)/.test(key))
    .map(key => ({ key, time: Date.parse(key) }))
    .filter(({ time }) => !Number.isNaN(time))
  const reached = timestamps.filter(({ time }) => time <= now)
  const pick = reached.length > 0
    ? reached.reduce((a, b) => (b.time > a.time ? b : a))
    : timestamps.reduce<typeof timestamps[number] | undefined>((a, b) => (!a || b.time < a.time ? b : a), undefined)
  const key = pick?.key ?? Object.keys(identityHistory)[0]
  return key === undefined ? undefined : identityHistory[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface RegistryResolution {
  tokenMetadata?: TokenMetadata
  isSchemaValid?: boolean
  metadataHashMatch?: boolean
  diagnostics: Diagnostic[]
}

/**
 * Fetch the registry for a publication once, verify its content hash over the raw
 * bytes, then look up and schema-validate the current identity snapshot for tokenId.
 */
export async function resolveRegistry(publication: BcmrPublication, tokenId: string): Promise<RegistryResolution> {
  const { httpsUrl, resolvedUri } = publication
  const diagnostics: Diagnostic[] = []
  const isIpfs = resolvedUri.startsWith('ipfs://') || httpsUrl.includes('/ipfs/')

  let response: Response
  let bytes: Uint8Array
  try {
    response = await fetch(httpsUrl)
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    diagnostics.push({
      type: 'fetch_failed',
      message: e instanceof TypeError
        ? isIpfs
          ? 'Unable to fetch metadata from IPFS gateway. The gateway may be down, slow, or the content may not be pinned.'
          : 'Unable to fetch metadata from URL. This is likely a CORS issue — the server needs to include an Access-Control-Allow-Origin header.'
        : `Failed to fetch metadata registry: ${message}`,
      details: `URL: ${httpsUrl}\nError: ${message}`
    })
    return { diagnostics }
  }

  if (!response.ok) {
    diagnostics.push({
      type: 'http_error',
      message: `HTTP ${response.status} when fetching metadata.`,
      details: `URL: ${httpsUrl}\nStatus: ${response.status} ${response.statusText}`
    })
    return { diagnostics }
  }

  // Hash the bytes as served: decoding to a string first would drop a BOM or
  // replace invalid UTF-8, making a correct commitment look like a mismatch.
  // A CID-only publication commits to the CID rather than a sha256, so it can't be compared.
  let metadataHashMatch: boolean | undefined
  if (!publication.isCidOnly) {
    const actualHash = binToHex(sha256.hash(bytes))
    metadataHashMatch = actualHash === publication.contentHash
    if (!metadataHashMatch) {
      diagnostics.push({
        type: 'hash_mismatch',
        message: 'On-chain content hash does not match the fetched metadata content.',
        details: `expected: ${publication.contentHash}\nactual: ${actualHash}`
      })
    }
  }

  let registry: unknown
  try {
    registry = JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    diagnostics.push({
      type: 'invalid_json',
      message: isIpfs
        ? 'IPFS gateway returned non-JSON content. The gateway may be returning an error page or the pinned content is not valid JSON.'
        : 'Server returned non-JSON content. The URL may be serving an HTML error page or Cloudflare challenge.',
      details: `URL: ${httpsUrl}\nError: ${e instanceof Error ? e.message : String(e)}`
    })
    return { metadataHashMatch, diagnostics }
  }

  const identityHistory = isRecord(registry) && isRecord(registry.identities) ? registry.identities[tokenId] : undefined
  const snapshot = isRecord(identityHistory) ? getCurrentSnapshot(identityHistory) : undefined
  if (!isRecord(snapshot)) {
    // Registry was fetched but has no entry for this tokenId (typically: txid is not a token category)
    console.log('No metadata entry found for this tokenId in the resolved registry')
    return { metadataHashMatch, diagnostics }
  }

  const validationResult = IdentitySnapshotSchema.safeParse(snapshot)
  if (!validationResult.success) {
    console.error('Token metadata schema validation failed:', validationResult.error.issues)
    diagnostics.push({
      type: 'schema_invalid',
      message: 'Token metadata does not fully conform to the BCMR schema.',
      details: validationResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')
    })
  }

  return {
    tokenMetadata: snapshot as TokenMetadata,
    isSchemaValid: validationResult.success,
    metadataHashMatch,
    diagnostics
  }
}
