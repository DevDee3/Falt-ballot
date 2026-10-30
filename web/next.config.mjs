import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // the verifier lives next to the web app and is imported as source
  experimental: { externalDir: true },
  webpack: (config) => {
    // one copy of viem in the bundle, even for files imported from ../verifier
    config.resolve.alias = {
      ...config.resolve.alias,
      viem: path.resolve(here, "node_modules/viem"),
      // optional peers of the Coinbase wallet SDK (x402 payments); we never call that code path
      "@x402/evm": false,
      "@x402/core": false,
      "@x402/svm": false,
      "@x402/fetch": false,
      "@x402/extensions": false,
      // optional Tempo wallet connector pulled in by @wagmi/core's barrel; never used here
      accounts: false,
    };
    // wallet SDKs reference these Node-only/optional modules; they are never used in the browser
    config.externals = [...(config.externals ?? []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};
export default nextConfig;
