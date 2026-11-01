/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // @bitauth/libauth instantiates its WASM crypto with top-level await
    config.experiments = { ...config.experiments, topLevelAwait: true };
    return config
  },
}
export default nextConfig;
