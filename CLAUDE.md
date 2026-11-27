# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Start development server (http://localhost:3000)
pnpm build        # Production build
pnpm start        # Start production server
pnpm lint         # Run ESLint
pnpm typecheck    # Run TypeScript type checking (includes JSX/TSX)
pnpm test         # Run unit tests (Vitest)
```

## Architecture Overview

This is a Next.js 15 application (Pages Router) that explores CashTokens metadata on Bitcoin Cash mainnet & chipnet. It displays BCMR (Bitcoin Cash Metadata Registries) token information including genesis supply, NFT counts, circulating supply, authchain data, and metadata verification.

BCMR is the metadata standard for CashTokens on BCH. It uses "authchains" (zeroth-descendant transaction chains) to authenticate and update metadata on-chain. Spec: https://github.com/bitjson/chip-bcmr

### Key Data Flow

1. User enters a tokenId (transaction hash) in the input field
2. Two parallel data fetches occur:
   - `lookUpTokenData()` - Queries Chaingraph for on-chain token info (genesis supply, NFT counts, holders, authchain). Runs in three phases: Phase 1 (fast queries: genesis, issuing UTXOs, authchain), Phase 2 (slow paginated holder query), Phase 3 (Electrum verification, non-blocking)
   - `fetchMetadata()` - Uses mainnet-js BCMR library to resolve and validate on-chain linked metadata

### External Dependencies

- **@mainnet-cash/bcmr** - Used for resolving on-chain BCMR metadata:
  - `BCMR.fetchAuthChainFromChaingraph()` - Fetches the authchain to find the metadata URI
  - `BCMR.addMetadataRegistryFromUri()` - Imports a registry from the resolved URL
  - `BCMR.getTokenInfo()` - Retrieves token metadata after importing
- **@bitauth/libauth** - Cryptographic primitives, transaction encoding (https://libauth.org/)
- **chaingraph-ts** - Typed GraphQL client for Chaingraph queries
- **@electrum-cash/protocol** - Electrum Cash client for UTXO verification against full nodes

### OTR (OpenTokenRegistry) Verification

The app checks if tokens are registered in the OpenTokenRegistry (https://otr.cash). Currently only checks if the tokenId is present in the registry, not whether the metadata matches. The registry is cached in memory for the session. See `src/utils/otrRegistry.ts`.

### BCMR Schema Validation

Runtime validation of BCMR data uses Zod schemas in `src/utils/bcmrSchema.ts`. This is a manual Zod implementation since Zod cannot validate directly from JSON Schema or TypeScript types.

For the schema definitions, see:
- TypeScript schema: https://github.com/bitjson/chip-bcmr/blob/master/bcmr-v2.schema.ts
- JSON schema: https://cashtokens.org/bcmr-v2.schema.json

### Authchain History Timeline

The `queryAuthchain()` Chaingraph query fetches the full authchain using the `migrations` field (ordered by `migration_index`). Each migration is classified as a "metadata update" or "identity transfer" by checking outputs for the BCMR OP_RETURN prefix (`6a0442434d52`).

Two data sources are merged in the UI:
- `tokenInfo.authchainMigrations` — basic entries from Chaingraph (txHash, timestamp, isMetadataUpdate, opReturnHex)
- `metadataInfo.authchainHistory` — BCMR-enriched entries from `BCMR.fetchAuthChainFromChaingraph()` (contentHash, httpsUrl, uris)

The `AuthchainTimeline` component in `AuthchainInfo.tsx` merges these by txHash, using migrations as the base and enriching with BCMR data. Pre-genesis migrations (from the funding tx) are filtered out using the genesis txHash.

The `LatestPublicationOutput` component decodes the raw OP_RETURN hex from the latest metadata update migration, parsing it into BCMR data pushes (protocol prefix, content hash, URIs) per the BCMR spec.

### Unspent Outputs Through `unspent_output`

`queryAllTokenHolders` and `queryIssuingUtxos` read the unspent outputs of a token category. Chaingraph instances running the ParyonUSD fork have an `unspent_output(node_name)` query root that answers this from the node's own unspent set in milliseconds; the generic `output` query with a `_not: { spent_by }` filter takes seconds or times out for tokens with many outputs. `src/utils/unspentOutputRoot.ts` picks the query:

- One request per endpoint checks the query root fields and node names. The answer is cached per endpoint URL and checked again after 5 minutes, after a failed generic query, and (as "no") when Hasura rejects `unspent_output`, in which case the query reruns with the generic version. This way a DNS switch to another instance heals itself.
- The node is the one that accepts the token's category transaction (the transaction whose hash is the tokenId). With one node on the instance no lookup is needed. If no node accepts it, the generic query is used.
- The `unspent_output` versions alias the root as `output`, so callers see the same result shape. Their `where` must filter `token_category`; that is what the function's indexes serve.

### Network Detection

The app detects chipnet vs mainnet from the node name in the genesis transaction's block inclusion data. This affects external links (Paytaca BCMR indexer URL) and is displayed in the UI.

### Verification Checks & Diagnostics

- **BCMR schema validation** — Zod schemas in `src/utils/bcmrSchema.ts`
- **Metadata hash match** — compares on-chain content hash with fetched content
- **BCMR origin match** — checks if the BCMR hosting domain matches the token's web URL
- **OTR verification** — checks if tokenId is present in the OpenTokenRegistry
- **Electrum UTXO verification** — cross-checks Chaingraph UTXOs against Electrum to detect stale data

When verification fails or metadata can't be fetched, `fetchMetadata()` populates a `diagnostics` array on `MetadataInfo` with structured errors (type, message, details). Error classification is IPFS-aware. The `DiagnosticsSection` component renders these in an expandable details block.

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
