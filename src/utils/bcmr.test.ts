import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { binToHex, encodeDataPush, sha256, utf8ToBin } from '@bitauth/libauth'
import {
  getCurrentSnapshot,
  isBcmrOutput,
  parseBcmrPublication,
  parseOpReturnPushes,
  resolveBcmrUri,
  resolveRegistry,
  selectLatestPublication,
  type BcmrPublication,
} from './bcmr'
import { parseAuthchainMigrations, type AuthchainQueryResult } from './queryChainGraph'
import type { AuthchainEntry } from '@/interfaces'
import { IPFS_GATEWAY } from '@/constants'

const GATEWAY = 'https://gateway.test/ipfs/'
const HASH = 'ab'.repeat(32)
const CID_V1 = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

const push = (data: Uint8Array) => binToHex(encodeDataPush(data))
const pushUtf8 = (text: string) => push(utf8ToBin(text))
/** OP_RETURN <'BCMR'> <hash> <uri>... */
const bcmrOutput = (hashHex: string, ...uris: string[]) =>
  '6a' + pushUtf8('BCMR') + push(Uint8Array.from(Buffer.from(hashHex, 'hex'))) + uris.map(pushUtf8).join('')

describe('isBcmrOutput', () => {
  it('matches the exact OP_RETURN OP_PUSHBYTES_4 BCMR prefix, case-insensitively', () => {
    expect(isBcmrOutput('6a0442434d52' + '20' + HASH)).toBe(true)
    expect(isBcmrOutput('6A0442434D52')).toBe(true)
  })

  it('rejects other outputs', () => {
    expect(isBcmrOutput('76a914' + '00'.repeat(20) + '88ac')).toBe(false)
    expect(isBcmrOutput('6a04534c5000')).toBe(false) // a different OP_RETURN protocol
    expect(isBcmrOutput('6a4c0442434d52')).toBe(false) // 'BCMR' pushed with PUSHDATA1
  })
})

describe('parseOpReturnPushes', () => {
  it('returns the data pushes after OP_RETURN as hex', () => {
    expect(parseOpReturnPushes('6a' + '0442434d52' + '02abcd')).toEqual(['42434d52', 'abcd'])
  })

  it('decodes PUSHDATA1 pushes', () => {
    const long = 'x'.repeat(100)
    expect(parseOpReturnPushes('6a' + pushUtf8(long))).toEqual([binToHex(utf8ToBin(long))])
  })

  it('stops at a truncated push', () => {
    expect(parseOpReturnPushes('6a' + '02abcd' + '05abcd')).toEqual(['abcd'])
  })
})

describe('parseBcmrPublication', () => {
  it('decodes a standard publication', () => {
    const publication = parseBcmrPublication(bcmrOutput(HASH, 'example.com/bcmr.json'))
    expect(publication).toEqual({
      contentHash: HASH,
      uris: ['example.com/bcmr.json'],
      httpsUrl: 'https://example.com/bcmr.json',
      resolvedUri: 'example.com/bcmr.json',
      isCidOnly: false,
    })
  })

  it('decodes a URI longer than 75 bytes (PUSHDATA1)', () => {
    const uri = `example.com/${'a'.repeat(80)}.json`
    const output = bcmrOutput(HASH, uri)
    // OP_RETURN (1 byte) + 'BCMR' push (5) + hash push (33), then the URI push opcode
    expect(output.slice(78, 80)).toBe('4c') // PUSHDATA1
    expect(parseBcmrPublication(output)?.httpsUrl).toBe(`https://${uri}`)
  })

  it.each([CID_V1, CID_V0])('recognises the non-spec CID-only form (%s)', cid => {
    const output = '6a' + pushUtf8('BCMR') + pushUtf8(cid)
    const publication = parseBcmrPublication(output)
    expect(publication?.isCidOnly).toBe(true)
    expect(publication?.uris).toEqual([`ipfs://${cid}`])
    expect(publication?.resolvedUri).toBe(`ipfs://${cid}`)
    expect(publication?.httpsUrl).toMatch(new RegExp(`/ipfs/${cid}$`))
  })

  it('has no fetchable URL for a spec hash-only publication', () => {
    const publication = parseBcmrPublication(bcmrOutput(HASH))
    expect(publication).toMatchObject({ contentHash: HASH, uris: [], httpsUrl: '', isCidOnly: false })
  })

  it('has no fetchable URL when the only URI is http://', () => {
    const publication = parseBcmrPublication(bcmrOutput(HASH, 'http://example.com/bcmr.json'))
    expect(publication?.uris).toEqual(['http://example.com/bcmr.json'])
    expect(publication?.httpsUrl).toBe('')
  })

  it('skips an unsupported URI and uses the next one', () => {
    const publication = parseBcmrPublication(
      bcmrOutput(HASH, 'http://example.com/bcmr.json', 'https://example.com/bcmr.json')
    )
    expect(publication?.httpsUrl).toBe('https://example.com/bcmr.json')
    expect(publication?.resolvedUri).toBe('https://example.com/bcmr.json')
  })

  it('returns undefined for malformed or non-BCMR outputs', () => {
    expect(parseBcmrPublication('6a0442434d52')).toBeUndefined() // no hash push
    expect(parseBcmrPublication('6a0442434d52' + '20' + 'ab'.repeat(10))).toBeUndefined() // truncated hash
    expect(parseBcmrPublication('6a4c0442434d52' + '20' + HASH)).toBeUndefined() // PUSHDATA1 'BCMR'
  })

  // Regression test: a truncated URI push used to be dropped silently, turning the
  // output into a seemingly valid hash-only publication
  it('returns undefined when a URI push is truncated', () => {
    const output = bcmrOutput(HASH) + '40' + binToHex(utf8ToBin('example.com'))
    expect(parseBcmrPublication(output)).toBeUndefined()
  })

  it.each([
    ['OP_NOP', '61'],
    ['OP_1', '51'],
  ])('returns undefined when a non-push opcode (%s) follows OP_RETURN', (_, opcode) => {
    expect(parseBcmrPublication(bcmrOutput(HASH, 'example.com') + opcode)).toBeUndefined()
  })

  it('returns undefined for an OP_0 hash push', () => {
    expect(parseBcmrPublication('6a' + pushUtf8('BCMR') + '00' + pushUtf8('example.com'))).toBeUndefined()
  })

  it('returns undefined for a hash push that is not 32 bytes', () => {
    expect(parseBcmrPublication(bcmrOutput('ab'.repeat(31), 'example.com'))).toBeUndefined()
    expect(parseBcmrPublication(bcmrOutput('ab'.repeat(33), 'example.com'))).toBeUndefined()
  })
})

describe('parseOpReturnPushes (lenient, for display)', () => {
  it('skips non-push opcodes instead of rejecting the output', () => {
    expect(parseOpReturnPushes('6a' + '02abcd' + '61' + '01ef')).toEqual(['abcd', 'ef'])
  })
})

describe('selectLatestPublication', () => {
  const TOKEN_ID = 'cd'.repeat(32)
  const entry = (txHash: string, opReturnHex?: string): AuthchainEntry => ({
    txHash,
    isMetadataUpdate: opReturnHex !== undefined,
    opReturnHex,
    publication: opReturnHex ? parseBcmrPublication(opReturnHex) : undefined,
  })
  const funding = entry('aa'.repeat(32), bcmrOutput(HASH, 'pre-authbase.example/bcmr.json'))
  const authbase = entry(TOKEN_ID)
  const first = entry('01'.repeat(32), bcmrOutput(HASH, 'example.com/v1.json'))
  const transfer = entry('02'.repeat(32))
  const second = entry('03'.repeat(32), bcmrOutput(HASH, 'example.com/v2.json'))

  it('picks the latest metadata update and counts updates from the authbase onward', () => {
    const selection = selectLatestPublication([funding, authbase, first, transfer, second], TOKEN_ID)
    expect(selection.metadataUpdates).toBe(2)
    expect(selection.latestUpdate).toBe(second)
    expect(selection.publication?.httpsUrl).toBe('https://example.com/v2.json')
    expect(selection.diagnostic).toBeUndefined()
  })

  it('ignores metadata updates before the authbase', () => {
    const selection = selectLatestPublication([funding, authbase, transfer], TOKEN_ID)
    expect(selection).toEqual({ metadataUpdates: 0, latestUpdate: undefined, publication: undefined })
  })

  it('reports a malformed latest publication without falling back to an older one', () => {
    const malformed = entry('04'.repeat(32), '6a0442434d52')
    const selection = selectLatestPublication([authbase, first, malformed], TOKEN_ID)
    expect(selection.metadataUpdates).toBe(2)
    expect(selection.publication).toBeUndefined()
    expect(selection.diagnostic).toMatchObject({ type: 'unresolvable_publication', message: expect.stringMatching(/malformed/) })
  })

  it('reports a latest publication with only an http:// URI', () => {
    const httpOnly = entry('05'.repeat(32), bcmrOutput(HASH, 'http://example.com/bcmr.json'))
    const selection = selectLatestPublication([authbase, first, httpOnly], TOKEN_ID)
    expect(selection.publication).toBeUndefined()
    expect(selection.diagnostic).toMatchObject({ type: 'unresolvable_publication', message: expect.stringMatching(/no URI/) })
    expect(selection.diagnostic?.details).toContain('URIs: http://example.com/bcmr.json')
  })
})

describe('parseAuthchainMigrations', () => {
  it('treats the first BCMR-prefixed output as definitive, even when it is malformed', () => {
    const malformed = '6a0442434d52' // no hash push
    const valid = bcmrOutput(HASH, 'example.com/bcmr.json')
    const result = {
      transaction: [{
        authchains: [{
          migrations: [{
            migration_index: '0',
            transaction: {
              hash: '\\x' + '01'.repeat(32),
              block_inclusions: [],
              outputs: [
                { output_index: '0', locking_bytecode: '\\x' + malformed },
                { output_index: '1', locking_bytecode: '\\x' + valid },
              ],
            },
          }],
        }],
      }],
    } as unknown as AuthchainQueryResult
    const [migration] = parseAuthchainMigrations(result)
    expect(migration).toMatchObject({ isMetadataUpdate: true, opReturnHex: malformed })
    expect(migration.publication).toBeUndefined()
  })
})

describe('resolveBcmrUri', () => {
  it.each([
    // protocol-less URIs are HTTPS; a bare domain resolves to the well-known path
    ['example.com', 'https://example.com/.well-known/bitcoin-cash-metadata-registry.json'],
    ['example.com/bcmr.json', 'https://example.com/bcmr.json'],
    ['example.com:8443/bcmr.json', 'https://example.com:8443/bcmr.json'],
    ['localhost:3000', 'https://localhost:3000/.well-known/bitcoin-cash-metadata-registry.json'],
    ['example.com/bcmr.json?v=2', 'https://example.com/bcmr.json?v=2'],
    ['example.com?v=2', 'https://example.com/?v=2'],
    // explicit https://, scheme case doesn't matter
    ['https://example.com', 'https://example.com/.well-known/bitcoin-cash-metadata-registry.json'],
    ['https://example.com/', 'https://example.com/.well-known/bitcoin-cash-metadata-registry.json'],
    ['https://example.com/bcmr.json', 'https://example.com/bcmr.json'],
    ['HTTPS://example.com/bcmr.json', 'https://example.com/bcmr.json'],
    // IPFS goes through the gateway
    [`ipfs://${CID_V1}`, `${GATEWAY}${CID_V1}`],
    [`IPFS://${CID_V1}`, `${GATEWAY}${CID_V1}`],
    // a subdomain gateway host serves the content at its root, not at the well-known path
    [`${CID_V1}.ipfs.dweb.link`, `https://${CID_V1}.ipfs.dweb.link/`],
  ])('%s -> %s', (uri, expected) => {
    expect(resolveBcmrUri(uri, GATEWAY)).toBe(expected)
  })

  it.each(['http://example.com/bcmr.json', 'ftp://example.com/bcmr.json'])('skips %s', uri => {
    expect(resolveBcmrUri(uri, GATEWAY)).toBeUndefined()
  })

  // Default gateway (IPFS_GATEWAY from constants)
  it('drops a redundant ipfs/ prefix: ipfs://ipfs/<cid>', () => {
    expect(resolveBcmrUri(`ipfs://ipfs/${CID_V1}`)).toBe(`${IPFS_GATEWAY}${CID_V1}`)
  })

  it('keeps the path after the CID: ipfs://<cid>/bcmr.json', () => {
    expect(resolveBcmrUri(`ipfs://${CID_V1}/bcmr.json`)).toBe(`${IPFS_GATEWAY}${CID_V1}/bcmr.json`)
  })
})

describe('getCurrentSnapshot', () => {
  const now = Date.parse('2025-06-01T00:00:00Z')

  it('picks the latest snapshot that has been reached, ignoring future and invalid keys', () => {
    const history = {
      '2024-01-01T00:00:00Z': 'old',
      '2025-01-01T00:00:00Z': 'current',
      '2026-01-01T00:00:00Z': 'future',
      '2025-13-45': 'invalid date',
      'not-a-timestamp': 'not a timestamp',
    }
    expect(getCurrentSnapshot(history, now)).toBe('current')
  })

  it('picks the oldest snapshot when none has been reached yet', () => {
    const history = { '2027-01-01T00:00:00Z': 'later', '2026-01-01T00:00:00Z': 'oldest' }
    expect(getCurrentSnapshot(history, now)).toBe('oldest')
  })

  it('falls back to the first key when no key is an ISO timestamp', () => {
    expect(getCurrentSnapshot({ first: 1, second: 2 }, now)).toBe(1)
  })

  it('returns undefined for an empty history', () => {
    expect(getCurrentSnapshot({}, now)).toBeUndefined()
  })
})

describe('resolveRegistry', () => {
  const TOKEN_ID = 'cd'.repeat(32)
  const URL_ = 'https://example.com/bcmr.json'

  const registryJson = (snapshot: object = { name: 'Test Token' }) =>
    JSON.stringify({ identities: { [TOKEN_ID]: { '2024-01-01T00:00:00Z': snapshot } } })
  const publicationFor = (body: Uint8Array | string, overrides: Partial<BcmrPublication> = {}): BcmrPublication => ({
    contentHash: binToHex(sha256.hash(typeof body === 'string' ? utf8ToBin(body) : body)),
    uris: [URL_],
    httpsUrl: URL_,
    resolvedUri: URL_,
    isCidOnly: false,
    ...overrides,
  })
  const mockFetch = (body: Uint8Array | string, init?: ResponseInit) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body as BodyInit, init)))

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns the validated snapshot when the hash matches', async () => {
    const body = registryJson()
    mockFetch(body)
    const result = await resolveRegistry(publicationFor(body), TOKEN_ID)
    expect(fetch).toHaveBeenCalledWith(URL_)
    expect(result).toEqual({
      tokenMetadata: { name: 'Test Token' },
      isSchemaValid: true,
      metadataHashMatch: true,
      diagnostics: [],
    })
  })

  it('reports a hash mismatch but still returns the metadata', async () => {
    mockFetch(registryJson())
    const result = await resolveRegistry(publicationFor('something else'), TOKEN_ID)
    expect(result.metadataHashMatch).toBe(false)
    expect(result.tokenMetadata).toEqual({ name: 'Test Token' })
    expect(result.diagnostics.map(d => d.type)).toEqual(['hash_mismatch'])
  })

  it('hashes the raw bytes, so a BOM-prefixed registry still matches', async () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8ToBin(registryJson())])
    mockFetch(body)
    const result = await resolveRegistry(publicationFor(body), TOKEN_ID)
    expect(result.metadataHashMatch).toBe(true)
    expect(result.tokenMetadata).toEqual({ name: 'Test Token' })
  })

  it('reports a non-2xx response as http_error', async () => {
    mockFetch('not found', { status: 404, statusText: 'Not Found' })
    const result = await resolveRegistry(publicationFor('x'), TOKEN_ID)
    expect(result.diagnostics).toEqual([expect.objectContaining({ type: 'http_error', message: 'HTTP 404 when fetching metadata.' })])
    expect(result.tokenMetadata).toBeUndefined()
  })

  it('reports non-JSON content as invalid_json', async () => {
    const body = '<html>challenge</html>'
    mockFetch(body)
    const result = await resolveRegistry(publicationFor(body), TOKEN_ID)
    expect(result.metadataHashMatch).toBe(true)
    expect(result.diagnostics.map(d => d.type)).toEqual(['invalid_json'])
  })

  it('reports a network/CORS failure as fetch_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await resolveRegistry(publicationFor('x'), TOKEN_ID)
    expect(result.diagnostics).toEqual([expect.objectContaining({ type: 'fetch_failed' })])
    expect(result.diagnostics[0].message).toMatch(/CORS/)
  })

  it('returns no tokenMetadata when the registry has no identity for the token', async () => {
    const body = JSON.stringify({ identities: { ['ef'.repeat(32)]: { '2024-01-01T00:00:00Z': { name: 'Other' } } } })
    mockFetch(body)
    const result = await resolveRegistry(publicationFor(body), TOKEN_ID)
    expect(result).toEqual({ metadataHashMatch: true, diagnostics: [] })
  })

  it('returns a schema-invalid snapshot with a schema_invalid diagnostic', async () => {
    const body = registryJson({ description: 'no name' })
    mockFetch(body)
    const result = await resolveRegistry(publicationFor(body), TOKEN_ID)
    expect(result.isSchemaValid).toBe(false)
    expect(result.tokenMetadata).toEqual({ description: 'no name' })
    expect(result.diagnostics).toEqual([expect.objectContaining({ type: 'schema_invalid' })])
    expect(result.diagnostics[0].details).toMatch(/^name:/)
  })

  it('does not compare hashes for a CID-only publication', async () => {
    const ipfsUrl = `${GATEWAY}${CID_V1}`
    mockFetch(registryJson())
    const publication = publicationFor('irrelevant', {
      contentHash: binToHex(utf8ToBin(CID_V1)),
      uris: [`ipfs://${CID_V1}`],
      httpsUrl: ipfsUrl,
      resolvedUri: `ipfs://${CID_V1}`,
      isCidOnly: true,
    })
    const result = await resolveRegistry(publication, TOKEN_ID)
    expect(result.metadataHashMatch).toBeUndefined()
    expect(result.tokenMetadata).toEqual({ name: 'Test Token' })
    expect(result.diagnostics).toEqual([])
  })
})
