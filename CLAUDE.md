# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Start development server (http://localhost:3000)
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # Run ESLint (flat config, fails on any warning)
pnpm typecheck    # Run TypeScript type checking (includes JSX/TSX)
pnpm test         # Run unit tests (Vitest, src/**/*.test.ts)
```

## Architecture Overview

This is a Next.js 15 application (Pages Router) that explores CashTokens metadata on Bitcoin Cash mainnet & chipnet. It displays BCMR (Bitcoin Cash Metadata Registries) token information including genesis supply, NFT counts, circulating supply, authchain data, and metadata verification.

BCMR is the metadata standard for CashTokens on BCH. It uses "authchains" (zeroth-descendant transaction chains) to authenticate and update metadata on-chain. Spec: https://github.com/bitjson/chip-bcmr

### Key Data Flow

1. User enters a tokenId (transaction hash) in the input field
2. `searchToken()` starts a single `queryAuthchain()` request and hands the promise to two parallel consumers:
   - `lookUpTokenData()` - Queries Chaingraph for on-chain token info (genesis supply, NFT counts, holders, authchain). Runs in three phases: Phase 1 (fast queries: genesis, issuing UTXOs, authchain), Phase 2 (slow paginated holder query), Phase 3 (Electrum verification, non-blocking)
   - `fetchMetadata()` - Takes the latest BCMR publication from the authchain migrations and resolves/validates the registry via `src/utils/bcmr.ts`

### Linting

ESLint CLI with a flat config in `eslint.config.mjs` (`next lint` is deprecated). It builds on `eslint-config-next` (core-web-vitals + typescript; flat-native since v16) and tightens it: `eslint-plugin-react-hooks` 7 recommended preset (incl. the React-Compiler-derived rules such as `set-state-in-effect`, `refs`, `purity`, `static-components`) with `rules-of-hooks`/`exhaustive-deps` as errors, plus a few bug-catching `eslint-plugin-react` rules. Rules turned off or considered and not enabled carry a one-line reason in the config. `pnpm lint` runs with `--max-warnings 0` and unused disable directives are errors. Inline disables use ESLint's native reason form on the directive itself: `// eslint-disable-next-line <rule> -- <reason>`. Global ignores are depth-independent (`**/.next/**` etc.) and include `.claude/**`, since flat config doesn't read `.gitignore`.

### External Dependencies

- **@bitauth/libauth** - Cryptographic primitives, transaction encoding (https://libauth.org/)
- **chaingraph-ts** - Typed GraphQL client for Chaingraph queries
- **@electrum-cash/protocol** - Electrum Cash client for UTXO verification against full nodes

### BCMR Resolution

`src/utils/bcmr.ts` is the explorer's own BCMR implementation (it replaced `@mainnet-cash/bcmr`):
- `isBcmrOutput()` / `parseBcmrPublication()` - detect and decode publication outputs (`OP_RETURN <'BCMR'> <sha256> <uri>...`, prefix exactly `6a0442434d52` per spec). The non-spec mainnet-js form `OP_RETURN <'BCMR'> <utf8 IPFS CID>` is recognised and flagged `isCidOnly`; a spec hash-only publication (no URIs) has no fetchable URL. Outputs with a truncated push, a non-push opcode after OP_RETURN, or a hash push that isn't 32 bytes (other than the CID form) are rejected as malformed
- `resolveBcmrUri()` - `ipfs://` via `IPFS_GATEWAY`, protocol-less URIs (incl. `host:port/...`) as HTTPS, a domain without a path to `/.well-known/bitcoin-cash-metadata-registry.json`; other protocols (e.g. `http://`) are skipped
- `resolveRegistry()` - fetches the registry once, checks the sha256 over the raw response bytes, parses JSON, selects the snapshot and Zod-validates it, returning structured diagnostics
- `getCurrentSnapshot()` - per spec: the snapshot with the latest reached timestamp, or the oldest one if none is reached yet; first key only if no key is an ISO timestamp

`fetchMetadata()` only resolves the **latest** metadata-update migration (from the tokenId tx onward), picked by `selectLatestPublication()` in `bcmr.ts`. If that publication is malformed or has no fetchable URI it reports an `unresolvable_publication` diagnostic rather than falling back to an older registry.

### OTR (OpenTokenRegistry) Verification

The app checks if tokens are registered in the OpenTokenRegistry (https://otr.cash). Currently only checks if the tokenId is present in the registry, not whether the metadata matches. The registry is cached in memory for the session. See `src/utils/otrRegistry.ts`.

### BCMR Schema Validation

Runtime validation of BCMR data uses Zod schemas in `src/utils/bcmrSchema.ts`. This is a manual Zod implementation since Zod cannot validate directly from JSON Schema or TypeScript types.

For the schema definitions, see:
- TypeScript schema: https://github.com/bitjson/chip-bcmr/blob/master/bcmr-v2.schema.ts
- JSON schema: https://cashtokens.org/bcmr-v2.schema.json

### Authchain History Timeline

The `queryAuthchain()` Chaingraph query fetches the full authchain using the `migrations` field (ordered by `migration_index`). Each migration is classified as a "metadata update" or "identity transfer" by checking outputs for the BCMR OP_RETURN prefix `6a0442434d52` (`isBcmrOutput()`).

`parseAuthchainMigrations()` (in `queryChainGraph.ts`) turns the migrations into `AuthchainEntry[]` (txHash, timestamp, isMetadataUpdate, opReturnHex) with the decoded BCMR `publication` attached. The same parsed list feeds both `tokenInfo.authchainMigrations` (the timeline) and `fetchMetadata()` (the latest publication), so there is no second authchain query and no merge step. The `AuthchainTimeline` component in `AuthchainInfo.tsx` filters out pre-genesis migrations (from the funding tx) using the genesis txHash; `fetchMetadata()` drops only migrations before the tokenId tx (the authbase) and counts metadata updates from there.

The `LatestPublicationOutput` component decodes the raw OP_RETURN hex from the latest metadata update migration into data pushes (protocol prefix, content hash, URIs) via `parseOpReturnPushes()`.

### Network Detection

The app detects chipnet vs mainnet from the node name in the genesis transaction's block inclusion data. This affects external links (Paytaca BCMR indexer URL) and is displayed in the UI.

### Verification Checks & Diagnostics

- **BCMR schema validation** — Zod schemas in `src/utils/bcmrSchema.ts`
- **Metadata hash match** — compares on-chain content hash with the sha256 of the fetched bytes (not checked for non-spec CID-only publications)
- **BCMR origin match** — checks if the BCMR hosting domain matches the token's web URL
- **OTR verification** — checks if tokenId is present in the OpenTokenRegistry
- **Electrum UTXO verification** — cross-checks Chaingraph UTXOs against Electrum to detect stale data

When verification fails or metadata can't be fetched, `fetchMetadata()` / `resolveRegistry()` populate a `diagnostics` array on `MetadataInfo` with structured errors (type, message, details). Error classification is IPFS-aware. The `DiagnosticsSection` component renders these in an expandable details block.

### Reserved & Circulating Supply

There are two supply calculations displayed in the UI:

**Primary:** Circulating supply = genesis supply − reserved supply. Reserved supply comes from Chaingraph (minting/mutable NFT outputs + authhead identity output FT) and is shown at the top immediately. When the opt-in Electrum verification is enabled, the section instead waits for Electrum and shows Electrum-verified figures. See `src/utils/queryElectrum.ts`.

**Advanced (Chaingraph-only):** Circulating supply excl. burns = totalSupplyFT − reservedSupplyFT. This uses `queryAllTokenHolders` (paginated, 5000 per page) to sum all unspent token outputs. Shown in the "Advanced ChainGraph Info" section. This method is less reliable when Chaingraph has stale data but can detect burns (genesis > current total).

### Electrum Verification (opt-in)

Some Chaingraph instances can serve stale UTXO data — reporting spent UTXOs as still unspent. To detect and correct this, the app can cross-verify token UTXOs via Electrum Cash servers which talk to full nodes directly. See `src/utils/queryElectrum.ts`.

**Toggle:** Electrum verification is **off by default** (the default Chaingraph instance is stable; verification slows down loading). It's enabled via a "verify supply via Electrum" checkbox in the footer, persisted in localStorage under the key `verifyElectrum`. It remains valuable as a debugging tool and for users pointing the app at their own Chaingraph instance. Implementation in `src/pages/index.tsx`: Phase 3 stores its arguments in `electrumArgsRef` and only runs when the toggle is on; ticking the checkbox while a token is loaded runs verification retroactively for that token, and unticking clears the Electrum results.

**Flow (when enabled):**
1. After `queryAllTokenHolders` completes (Phase 2), collect all unique locking bytecodes from the results
2. Convert each to a CashAddress via `lockingBytecodeToCashAddress` (libauth)
3. Connect to Electrum server (mainnet: `electrum.imaginary.cash`, chipnet: `chipnet.bch.ninja`) with `disableBrowserVisibilityHandling: true` to prevent disconnects when the tab loses focus
4. Query all addresses in parallel via `fetchUnspentTransactionOutputs` with token filter
5. Filter Electrum results by token category, compare UTXO sets (match on `tx_hash` + `tx_pos`)
6. Track: stale UTXOs (in Chaingraph but not Electrum), missing UTXOs (in Electrum but not Chaingraph), and recalculate reserved FT from Electrum data (including authhead identity output)
7. Also verify the authhead UTXO is unspent — shown as a badge in AuthchainInfo

**UI display:**
- With verification disabled, the supply section shows Chaingraph figures immediately (no waiting, no verification badges)
- With verification enabled, the supply section waits for Electrum before showing circulating/reserved (to avoid flashing wrong numbers from stale Chaingraph data)
- Green badge: "supply verified via Electrum" when Chaingraph and Electrum reserves match
- Blue badge: "used Electrum to select the accurate UTXOs from Chaingraph" when they differ
- Yellow warning in Advanced section when Chaingraph UTXOs don't match Electrum
- Green badge on authhead: "authhead UTXO confirmed unspent via Electrum"
- Electrum failure is non-blocking — falls back to Chaingraph with "(unverified)" label

**Constants:** Electrum server hostnames are in `src/constants.ts` (`ELECTRUM_MAINNET`, `ELECTRUM_CHIPNET`).

### Token Data Types

The explorer handles three token scenarios:
- Fungible Tokens only (has `genesisSupplyFT`, no NFTs)
- NFTs only (has `totalSupplyNFTs`, no FT supply)
- Both FT and NFTs combined

NFT display includes sequential collection detection and parsable NFT commitment info.
