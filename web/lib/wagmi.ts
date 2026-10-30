import { cookieStorage, createStorage } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { defineChain } from "@reown/appkit/networks";
import { CONFIG } from "./config";

/**
 * Wallet connections go through Reown AppKit (WalletConnect). Create a free project at
 * https://cloud.reown.com, copy its project ID into NEXT_PUBLIC_REOWN_PROJECT_ID, and add your
 * site's domain to the project's allowed domains.
 * Without an ID the modal still lists injected browser wallets, but WalletConnect QR pairing is off.
 */
const PLACEHOLDER_ID = "00000000000000000000000000000000";
export const reownProjectId = (process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "").trim();
export const hasReownProject = reownProjectId !== "";

export const appNetwork = defineChain({
  id: CONFIG.chainId,
  caipNetworkId: `eip155:${CONFIG.chainId}`,
  chainNamespace: "eip155",
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: { default: { name: "Explorer", url: CONFIG.explorer } },
});

const projectId = hasReownProject ? reownProjectId : PLACEHOLDER_ID;

export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [appNetwork],
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

const siteUrl = typeof window !== "undefined" ? window.location.origin : "https://flat-ballot.vercel.app";

export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [appNetwork],
  defaultNetwork: appNetwork,
  metadata: {
    name: "Flat Ballot",
    description: "Public $WIF elections on Robinhood Chain",
    url: siteUrl,
    icons: [`${siteUrl}/icon.svg`],
  },
  themeMode: "light",
  themeVariables: {
    "--w3m-accent": "#0f2233",
    "--w3m-border-radius-master": "2px",
    "--w3m-font-family": '"Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif',
  },
  features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
});
