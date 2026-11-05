# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Project Overview

[tokenexplorer.cash](https://tokenexplorer.cash) explores CashTokens on Bitcoin Cash (mainnet and chipnet): genesis and circulating supply, NFTs, holders, the authchain, and the token's BCMR metadata with checks on whether that metadata can be trusted. It is a single-page React app built with Vite and TypeScript, deployed to Netlify as a static site. There is one page; a token is looked up with `?tokenId=<category>`.

Background reading:
- CashTokens: https://cashtokens.org
- BCMR spec (metadata registries, authchains, publication outputs): https://github.com/bitjson/chip-bcmr
- Chaingraph (the GraphQL indexer queried for on-chain data): https://chaingraph.cash
- libauth: https://libauth.org

## Commands

Uses pnpm (version pinned via `packageManager`).

```bash
pnpm dev          # Vite dev server
pnpm build        # tsc -b, then vite build to dist/
pnpm preview      # serve dist/
pnpm lint         # ESLint, fails on any warning
pnpm typecheck    # tsc -b (app + node projects)
pnpm test         # Vitest unit tests
```

## Architecture

### The model
Everything the page shows is derived in the browser from four sources, and none of them is fully trusted:
- **Chaingraph** for on-chain facts: genesis outputs, unspent token outputs, the authchain. Queries are in `src/utils/queryChainGraph.ts`, typed from the schema by `chaingraph-ts` (gql.tada). The default instance is public; `NEXT_PUBLIC_CHAINGRAPH_URL` points the build at another one. Instances run different codebases: upstream [bitauth/chaingraph](https://github.com/bitauth/chaingraph), or forks such as [ParyonUSD/chaingraph](https://github.com/ParyonUSD/chaingraph), which adds many fixes (a `token_category` index, expiry of transactions dropped from the mempool, reorg and mempool resync fixes, write-path performance). Query speed and how dropped transactions show up differ a lot between them. The deployed site sets `NEXT_PUBLIC_CHAINGRAPH_URL` to its own instance, so the public default is what local builds and forks of this repo get, not what tokenexplorer.cash users see. When testing or measuring a query, note which instance and codebase you hit.
- **The token's BCMR registry**, found by following the authchain to its latest publication output and fetched from the URI it commits to.
- **OpenTokenRegistry** (https://otr.cash), only to check whether the tokenId is listed.
- **Electrum** (opt-in), to cross-check Chaingraph's UTXO set against a full node, because a Chaingraph instance can serve stale data.

The UI's job is to show what each source says and where they disagree, not to hide it: verification checks, diagnostics and "(unverified)" labels are features.

### Search flow (`src/App.tsx`)
`searchToken()` issues one authchain query and hands it to two parallel consumers: `lookUpTokenData()` (on-chain data in phases: fast queries, then the paginated holder query, then optional Electrum verification) and `fetchMetadata()` (BCMR resolution). Every search bumps a generation counter, and each async step checks `isCurrent()` before setting state, so a superseded search never overwrites the view. Requests are not aborted, only their results dropped.

### BCMR (`src/utils/bcmr.ts`)
The explorer's own implementation of the spec: decode publication outputs, resolve their URIs (IPFS through `IPFS_GATEWAY`), fetch the registry once and hash the raw bytes against the on-chain commitment, pick the current identity snapshot, and validate it with the Zod schemas in `src/utils/bcmrSchema.ts`. Only the latest publication counts; if it can't be used, that is reported as a diagnostic rather than falling back to an older registry. Deviations from the spec are deliberate and commented in the code.

### Supply
The headline shows the naive circulating supply: genesis supply minus reserved supply (minting/mutable NFT outputs plus the authhead's identity output), available after the fast Phase 1 queries. Once the holder query (all unspent token outputs) is in, it adds "Burned" (genesis minus all unspent) and "Circulating (excl. burns)" (unspent minus reserved). "Removed from supply" splits the burned figure into known burns and tokens no longer in any output (spent but not passed on, e.g. a wallet bug or a contract doing so on purpose). Known burns (`src/utils/burns.ts`, a separate fast query) are token outputs that provably can't be spent: OP_RETURN outputs and outputs sent to the tokenburner.cash burner contract (`TOKENBURNER_LOCKING_BYTECODE`), spent or not. They are excluded from holdings and reserved supply so nothing counts twice. Burning is routine for some protocols (e.g. repaid stablecoin loans), so the UI stays neutral and avoids words like "lost". Held + burned + reserved = genesis. The holder-query figures are the first to go wrong when Chaingraph is stale.

### Rendering and hosting
Nothing is prerendered: `index.html` holds the head tags, a pre-paint theme script and a "Loading…" placeholder, and `src/main.tsx` mounts the app. Browser state (theme, settings, the initial `?tokenId=`) is read in lazy `useState` initializers, not effects. `netlify.toml` holds the build, Node version and cache headers.

## Conventions

- **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess` and `noImplicitOverride`. `tsconfig.json` references `tsconfig.app.json` (app code, browser types) and `tsconfig.node.json` (`vite.config.ts` and tests, with Node types). A new TS file must fall in one of their `include`s, or type-aware lint errors.
- **Lint is strict and type-aware** (`eslint.config.mjs`). Each rule that is off has its reason next to it. Don't cast what the types already say (Chaingraph scalars are strings). Treat external JSON and caught errors as `unknown` and narrow or Zod-validate them. A promise is awaited, caught, or fired with `void` plus a comment saying where it's handled. Inline disables carry a reason: `// eslint-disable-next-line <rule> -- <reason>`.
- **Tests** sit next to the code (`*.test.ts`, Vitest config in `vite.config.ts`). Test behaviour against the spec, not the implementation.
- **No private infrastructure in the repo**: only public defaults go in `src/constants.ts`, docs, commits or PR text. Other Chaingraph instances are configured via `.env`.
- **Comments earn their place**: explain intent, spec decisions or non-obvious constraints, not what the code already says.
