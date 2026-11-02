import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { binToHex, encodeDataPush, sha256, utf8ToBin } from '@bitauth/libauth'
import {
  getCurrentSnapshot,
  isBcmrOutput,
  parseBcmrPublication,
  parseOpReturnPushes,
  resolveBcmrUri,
  resolveRegistry,
  type BcmrPublication,
} from './bcmr'

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
    expect(output).toContain('4c') // PUSHDATA1 opcode is used
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

  it('returns undefined when a URI push is truncated', () => {
    const output = bcmrOutput(HASH) + '40' + binToHex(utf8ToBin('example.com'))
    expect(parseBcmrPublication(output)).toBeUndefined()
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
