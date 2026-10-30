import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";
import { flatBallotAbi } from "@verifier";
import { CONFIG } from "./config";
import { wagmiConfig } from "./wagmi";

export const chain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: { default: { name: "Explorer", url: CONFIG.explorer } },
});

export const publicClient = createPublicClient({ chain, transport: http(CONFIG.rpcUrl), batch: { multicall: false } });

export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export { flatBallotAbi };

/** Send a contract write through the connected wallet (WalletConnect or injected) and wait for the receipt. */
export async function writeAndWait(account: Address, req: { address: Address; abi: any; functionName: string; args: any[] }): Promise<Hex> {
  const current = getAccount(wagmiConfig);
  if (current.chainId !== CONFIG.chainId) await switchChain(wagmiConfig, { chainId: CONFIG.chainId });
  // simulate first so reverts surface with the contract's custom error name instead of an opaque wallet failure
  await publicClient.simulateContract({ ...req, account } as any);
  const wallet = await getWalletClient(wagmiConfig, { chainId: CONFIG.chainId, account });
  const hash = await wallet.writeContract({ ...req, account, chain } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
  return hash;
}

export function readableError(e: unknown): string {
  const err = e as any;
  const name = err?.cause?.data?.errorName ?? err?.data?.errorName ?? err?.cause?.cause?.data?.errorName;
  if (name) return ERROR_HELP[name] ?? `The contract rejected this action (${name}).`;
  if (err?.code === 4001 || /user rejected/i.test(err?.message ?? "")) return "You rejected the request in your wallet.";
  return (err?.shortMessage ?? err?.message ?? "Something went wrong.").split("\n")[0];
}

const ERROR_HELP: Record<string, string> = {
  BadParams: "One of the values is out of range. Check the title, options, vote cost, dates and slots.",
  BadState: "This election is not in the right state for that action.",
  TooEarly: "Too early for that action. Wait until the required time or block.",
  TooLate: "This window has closed.",
  NotResolver: "Only this election's resolver can do that.",
  AlreadySwept: "That option's votes are already burned.",
  NotAllSwept: "Burn the votes of every option first.",
  BadResults: "The submitted result is invalid: more votes than were burned, or a missing root.",
  BadProof: "The claim proof does not match the committed result.",
  AlreadyClaimed: "This prize was already claimed.",
  TransferFailed: "The $WIF transfer failed. Check your balance and allowance.",
  SeedExpired: "The draw block is out of range. Call reseed first.",
  NothingToDo: "There is nothing to do here.",
};
