// The pat.mn fallback can time out on heavier queries (e.g. queryIssuingUtxos
// for tokens with many UTXOs), which surfaces as missing reserved-supply data.
// Override via NEXT_PUBLIC_CHAINGRAPH_URL to point at a more powerful instance.
export const CHAINGRAPH_URL =
  import.meta.env.NEXT_PUBLIC_CHAINGRAPH_URL ?? "https://gql.chaingraph.pat.mn/v1/graphql";
// dweb.link, along with ipfs.io, w3s.link and nftstorage.link, is one backend behind
// Cloudflare bot management: on a challenged connection every request gets a 403
// challenge page, so metadata fetches and token icons fail. filebase serves the
// content directly with CORS headers on the response instead of redirecting to a
// subdomain gateway, which a fetch of the BCMR JSON needs.
export const IPFS_GATEWAY = "https://ipfs.filebase.io/ipfs/";
export const BLOCK_EXPLORER_URL = "https://explorer.bch.ninja/tx/";
export const OTR_REGISTRY_URL = "https://otr.cash/.well-known/bitcoin-cash-metadata-registry.json";
export const ELECTRUM_MAINNET = "electrum.imaginary.cash";
export const ELECTRUM_CHIPNET = "chipnet.bch.ninja";

// Sample tokens shown on the landing screen before the first search.
export const EXAMPLE_TOKENS = [
  { name: "DogeCash", id: "8473d94f604de351cdee3030f6c354d36b257861ad8e95bbc0a06fbab2a2f9cf" },
  { name: "ParyonUSD", id: "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544" },
  { name: "Furu Token", id: "d9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea" },
];
