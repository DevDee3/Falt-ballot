/**
 * Seeds a local anvil chain for UI testing and demos.
 *   anvil --port 8545 &   then   npx tsx scripts/seed-local.ts
 * Prints the deployed addresses; it never changes the web app environment file.
 *
 * Election #1: a complete lifecycle (votes incl. a sybil cluster -> burn -> verified commit -> draw).
 * Election #2: open right now, with a few votes in.
 */
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { flatBallotAbi, flatBallotBytecode, mockWifAbi, mockWifBytecode } from "../src/abi";
import { computeFromChain } from "../src/chain";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const UNIT = 10n ** 18n;
const BOND = 1_000n * UNIT;
const mnemonic = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(mnemonic, { addressIndex: i });

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
const wallet = (i: number) => createWalletClient({ account: acct(i), chain: foundry, transport: http(RPC) });

async function tx(i: number, address: Address, abi: any, functionName: string, args: any[]) {
  const hash = await wallet(i).writeContract({ address, abi, functionName, args } as any);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

async function main() {
  const deployer = wallet(0);
  const dep = async (abi: any, bytecode: Hex, args: any[] = []) =>
    (await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args }) })).contractAddress as Address;

  const wif = await dep(mockWifAbi, mockWifBytecode as Hex);
  const wifBlock = await pub.getBlockNumber();
  const ballot = await dep(flatBallotAbi, flatBallotBytecode as Hex, [wif, BOND]);
  const deployBlock = await pub.getBlockNumber();

  // fund everyone with WIF and approve the ballot
  for (let i = 0; i < 10; i++) {
    await tx(0, wif, mockWifAbi, "mint", [acct(i).address, 1_000_000n * UNIT]);
    await tx(i, wif, mockWifAbi, "approve", [ballot, 2n ** 256n - 1n]);
  }

  const resolver = acct(1).address;
  const create = async (title: string, labels: string[], durationSec: number, prize: bigint, minVotes: bigint) => {
    const now = Number((await pub.getBlock()).timestamp);
    const r = await tx(0, ballot, flatBallotAbi, "createElection", [
      {
        title,
        labels,
        beneficiaries: labels.map((_, i) => (i === 0 ? acct(9).address : zeroAddress)),
        resolver,
        voteStart: 0,
        voteEnd: now + durationSec,
        voteCost: UNIT,
        minVotes,
        slots: 5,
        bountyBps: 2000,
        initialPrize: prize,
        metadataURI: "",
      },
    ]);
    const id = (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "nextElectionId" })) as bigint;
    return { id, block: r.blockNumber };
  };
  const box = async (id: bigint, o: number) => (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "boxAddress", args: [id, BigInt(o)] })) as Address;
  const vote = async (voter: number, id: bigint, o: number) => tx(voter, wif, mockWifAbi, "transfer", [await box(id, o), UNIT]);

  // ---- election 1: full lifecycle ----
  const e1 = await create("Who is the best trader on the timeline?", ["Ansem", "Hsaka", "Cobie", "Murad"], 3600, 10_000n * UNIT, 5n);
  // accounts 2..4 are funded by account 0 (the deployer) => one funder cluster of 3 (cap 3: all count)
  // plus extra throwaway wallets all funded by account 2 => they collapse under the cap
  const sybils = Array.from({ length: 5 }, (_, k) => mnemonicToAccount(mnemonic, { addressIndex: 20 + k }));
  for (const s of sybils) {
    await test.setBalance({ address: s.address, value: parseEther("1") });
    await tx(2, wif, mockWifAbi, "transfer", [s.address, 3n * UNIT]);
  }
  await vote(3, e1.id, 0);
  await vote(4, e1.id, 1);
  await vote(5, e1.id, 1);
  await vote(6, e1.id, 2);
  await vote(7, e1.id, 1);
  await vote(8, e1.id, 3);
  await vote(3, e1.id, 2); // duplicate wallet
  for (const s of sybils) {
    const hash = await createWalletClient({ account: s, chain: foundry, transport: http(RPC) }).writeContract({
      address: wif, abi: mockWifAbi, functionName: "transfer", args: [await box(e1.id, 0), UNIT],
    } as any);
    await pub.waitForTransactionReceipt({ hash });
  }

  await test.increaseTime({ seconds: 3700 });
  await test.mine({ blocks: 1 });
  for (let o = 0; o < 4; o++) await tx(0, ballot, flatBallotAbi, "sweep", [e1.id, BigInt(o)]);

  const g = await computeFromChain(pub, { ballot, wif, id: e1.id, fromBlock: e1.block - 1n, funderFromBlock: wifBlock, chunk: 1000n });
  await tx(1, ballot, flatBallotAbi, "commitResults", [e1.id, g.result.root, g.result.rulesHash, g.result.optionVotes.map(BigInt)]);
  await test.mine({ blocks: 45 });
  await tx(0, ballot, flatBallotAbi, "finalize", [e1.id]);
  console.log("election 1 verified votes:", g.result.optionVotes.join(","), "rejected:", g.result.rejected.length);

  // ---- election 2: open ----
  const e2 = await create("Best meme of the cycle?", ["Flat earth", "Round earth", "Both are fine"], 7 * 86400, 2_500n * UNIT, 3n);
  await vote(3, e2.id, 0);
  await vote(4, e2.id, 0);
  await vote(5, e2.id, 1);

  console.log("local seed complete; web/.env.local was not changed");
  console.log({ chainId: 31337, rpcUrl: RPC, wif, ballot, deployBlock, wifDeployBlock: wifBlock });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
