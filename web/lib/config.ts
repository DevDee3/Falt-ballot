import type { Address } from "viem";

const env = (v: string | undefined, d = "") => (v && v.trim() !== "" ? v.trim() : d);

export const CONFIG = {
  chainId: Number(env(process.env.NEXT_PUBLIC_CHAIN_ID, "4663")),
  rpcUrl: env(process.env.NEXT_PUBLIC_RPC_URL, "https://rpc.mainnet.chain.robinhood.com"),
  explorer: env(process.env.NEXT_PUBLIC_EXPLORER, "https://robinhoodchain.blockscout.com"),
  wif: env(process.env.NEXT_PUBLIC_WIF, "0x5173b8eA6923c2d40267890D45C46a3480954773") as Address,
  ballot: env(process.env.NEXT_PUBLIC_BALLOT) as Address | "",
  deployBlock: BigInt(env(process.env.NEXT_PUBLIC_DEPLOY_BLOCK, "0")),
  wifDeployBlock: BigInt(env(process.env.NEXT_PUBLIC_WIF_DEPLOY_BLOCK, "0")),
  logChunk: BigInt(env(process.env.NEXT_PUBLIC_LOG_CHUNK, "50000")),
  chainName: env(process.env.NEXT_PUBLIC_CHAIN_NAME, "Robinhood Chain"),
};

export const configured = CONFIG.ballot !== "";
