# CashToken Explorer

This is the code repository for [tokenexplorer.cash](https://tokenexplorer.cash/). Explore CashTokens metadata, supply, holders and authchain on Bitcoin Cash (mainnet & chipnet).

![screenshotHomePage](./screenshots/screenshotHomePage.png)

## Features

The token explorer shows a token's BCMR metadata and on-chain info: the genesis supply of FTs, the number of NFTs, active minting NFTs, circulating & reserved supply of FTs, holder counts, the location of the authHead, the location of the metadata file, the authChain length, the number of metadata updates and whether the metadata hash matches.

The interface has a clean card-based layout with light & dark mode, and the home page lists example tokens to explore.

It's also a handy tool for token creators, who can use the "Verification" checks to confirm their token's BCMR metadata is valid, correctly hashed on-chain, and properly registered.

Take a look at [the token info of DogeCash](https://tokenexplorer.cash/?tokenId=8473d94f604de351cdee3030f6c354d36b257861ad8e95bbc0a06fbab2a2f9cf) as an example.

![ScreenshotDogeCash](./screenshots/ScreenshotDogeCash.png)

![ScreenshotDogeCash2](./screenshots/ScreenshotDogeCash2.png)

## How the data is fetched

On-chain token info (the genesis transaction, genesis supply of FTs, active minting UTXOs, holders and the authchain) is queried from [Chaingraph](https://chaingraph.cash/). The Chaingraph instance defaults to a [public instance](https://gql.chaingraph.pat.mn/v1/graphql) but is configurable via the `NEXT_PUBLIC_CHAINGRAPH_URL` environment variable (read at build time; the `NEXT_PUBLIC_` name is kept from the Next.js version of the app).

Because a Chaingraph instance can serve stale UTXO data (reporting already-spent UTXOs as unspent), the reserved and circulating supply can optionally be cross-verified against Electrum Cash servers, which talk to full nodes directly. This is off by default and enabled with the "verify supply via Electrum" checkbox in the footer (remembered in the browser). When enabled, Electrum is used to confirm which of Chaingraph's UTXOs are actually still unspent; if the two disagree, Electrum's view is used and the discrepancy is surfaced in the UI. Electrum verification is non-blocking: if it fails, the explorer falls back to Chaingraph data labelled as unverified.

## Development

The app is a static React single-page app built with [Vite](https://vite.dev/).

```bash
pnpm install
pnpm dev          # dev server on http://localhost:5173
pnpm build        # type check + production build to dist/
pnpm preview      # serve the production build
pnpm lint
pnpm typecheck
```

To use another Chaingraph instance, set the variable when building or starting the dev server, e.g. `NEXT_PUBLIC_CHAINGRAPH_URL=https://example.com/v1/graphql pnpm build`. The site is deployed on Netlify as a static build (see `netlify.toml`).

## How it was made

The project was started from the [mainnet-js React-next](https://github.com/mainnet-cash/mainnet-js/tree/master/demo/react-next) example and later moved from Next.js to Vite, since it is a single client-side page.
On-chain linked Bitcoin Cash Metadata Registries (BCMR) were originally resolved with [mainnet-js](https://mainnet.cash/); the explorer now resolves them itself (`src/utils/bcmr.ts`), reusing the authchain data it already queries from Chaingraph.
